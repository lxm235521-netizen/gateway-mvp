"use strict";

/**
 * Optional prompt-optimization step.
 *
 * When a logical model has prompt optimization enabled, the gateway sends the
 * caller's prompt text plus the input images to an external OpenAI-compatible
 * chat-completions service, then writes the optimized text back over the
 * caller's prompt before the request is mapped and forwarded upstream.
 *
 * The step is best-effort: any failure returns the original payload together
 * with a reason, so the upstream generation still runs with the user's own
 * prompt. All decisions are driven by the per-model configuration columns.
 */

const axios = require("axios");
const {
    extractPrompt,
    applyOptimizedPrompt,
    parseOptimizerResponse,
    buildContentParts,
    validateMedia
} = require("./prompt-optimizer");

const DEFAULT_BASE_URL = process.env.OPTIMIZER_BASE_URL || "https://api.mmg.lat";
const DEFAULT_API_KEY = process.env.OPTIMIZER_API_KEY || "";
const DEFAULT_MODEL = process.env.OPTIMIZER_MODEL || "h3-prompt-writing";
const DEFAULT_TIMEOUT_MS = 120000;

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;
const DEFAULT_MEDIA_BYTES = 8 * 1024 * 1024;

// The external service only reads inline data URLs for images; plain https URLs
// are rejected. This gateway fetches such images and inlines them.
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SUPPORTED_MEDIA_KINDS = new Set(["image", "video", "audio"]);

// Documented way to ask the service for structured output.
const JSON_MODE_HINT = "请返回 json 格式。";

const DEFAULT_SYSTEM_PROMPT = [
    "你是视频提示词改写专家。请把用户给出的提示词改写为结构清晰、可直接驱动视频生成模型的提示词。",
    "要求：保留用户原始意图、人物、台词、时长与画幅信息，不要新增用户没有要求的情节；如果输入包含图片，请结合图片内容改写。",
    "只输出改写后的提示词正文，不要输出解释、前言或 markdown 代码块。"
].join("\n");

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

function normalizeBaseUrl(baseUrl) {
    return safeString(baseUrl).trim().replace(/\/+$/, "");
}

// Accepts a base URL ("https://api.mmg.lat") or a full endpoint URL.
function buildChatCompletionsUrl(baseUrl) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) {
        return "";
    }
    if (/\/v1\/chat\/completions$/i.test(base)) {
        return base;
    }
    return base + "/v1/chat/completions";
}

function resolveTimeout(modelConfig) {
    const raw = Number(modelConfig && modelConfig.optimizer_timeout_ms);
    if (!Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// Tolerates "image,video", "image video", "image|video" and casing variants.
function parseMediaKinds(value) {
    const kinds = new Set();
    for (const token of safeString(value).split(/[,\s|;]+/)) {
        const kind = token.trim().toLowerCase();
        if (SUPPORTED_MEDIA_KINDS.has(kind)) {
            kinds.add(kind);
        }
    }
    if (kinds.size === 0) {
        kinds.add("image");
    }
    return kinds;
}

function sniffImageType(buffer, declared) {
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return "image/png";
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    if (buffer.length >= 6 && buffer.slice(0, 6).toString("ascii").startsWith("GIF8")) {
        return "image/gif";
    }
    if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
        return "image/webp";
    }
    const declaredType = safeString(declared).split(";")[0].trim().toLowerCase();
    return SUPPORTED_IMAGE_TYPES.has(declaredType) ? declaredType : null;
}

function buildDataUrl(buffer, contentType) {
    return `data:${contentType};base64,${buffer.toString("base64")}`;
}

// Base64 (or data URL) image data passed by the caller, normalized to a data URL.
// Returns null when the payload is not a recognizable image.
function normalizeInlineImage(value) {
    const text = safeString(value).trim();
    if (!text) {
        return null;
    }
    const match = text.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match) {
        const buffer = Buffer.from(text.replace(/\s/g, ""), "base64");
        if (buffer.length === 0) {
            return null;
        }
        const contentType = sniffImageType(buffer, null);
        return contentType ? buildDataUrl(buffer, contentType) : null;
    }
    const isBase64 = Boolean(match[2]);
    const contentType = sniffImageType(Buffer.from(match[3] || "", isBase64 ? "base64" : "utf8"), match[1]);
    if (!contentType) {
        return null;
    }
    return buildDataUrl(Buffer.from(match[3] || "", isBase64 ? "base64" : "utf8"), contentType);
}

async function fetchImageAsDataUrl(url, maxBytes, timeoutMs) {
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        timeout: timeoutMs,
        validateStatus: status => status >= 200 && status < 300
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length === 0) {
        throw new Error("图片内容为空");
    }
    if (buffer.length > maxBytes) {
        throw new Error("图片超过大小限制");
    }
    const contentType = sniffImageType(buffer, response.headers && response.headers["content-type"]);
    if (!contentType) {
        throw new Error("图片格式不受支持，仅支持 png/jpeg/gif/webp");
    }
    return buildDataUrl(buffer, contentType);
}

// The optimizer expects inline data URLs, so http(s) images are downloaded here.
// Every item keeps kind: "image" because buildContentParts filters on it.
async function resolveImages(images, maxBytes, timeoutMs) {
    const resolved = [];
    for (const image of images) {
        const url = safeString(image.url).trim();
        if (/^https?:\/\//i.test(url)) {
            resolved.push({ kind: "image", url: await fetchImageAsDataUrl(url, maxBytes, timeoutMs) });
        } else {
            const dataUrl = normalizeInlineImage(url);
            if (!dataUrl) {
                throw new Error("图片格式不受支持，仅支持 Data URL 或 png/jpeg/gif/webp base64");
            }
            resolved.push({ kind: "image", url: dataUrl });
        }
    }
    return resolved;
}

function isInsecureHttp(url) {
    return /^http:\/\//i.test(safeString(url));
}

// Authorization headers are only sent over https, unless the operator explicitly
// allows plain http for a self-hosted optimizer.
function buildOptimizerHeaders(apiKey, url, allowInsecureHttp) {
    const headers = { "Content-Type": "application/json" };
    const secure = /^https:/i.test(url) || (allowInsecureHttp && isInsecureHttp(url));
    if (apiKey && secure) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
}

function isInsecureHttpAllowed(config) {
    const value = config && config.optimizer_allow_http;
    return value === 1 || value === true || value === "1";
}

// How many optimizer calls may be in flight at once. The optimizer account is
// provisioned well beyond this gateway's traffic, so the default does not queue
// at all; lower it only if the optimizer starts answering with
// "Concurrency limit exceeded".
const DEFAULT_OPTIMIZER_CONCURRENCY = 500;
const MAX_OPTIMIZER_CONCURRENCY = 500;
const DEFAULT_QUEUE_WAIT_MS = 300000;
const MAX_QUEUE_WAIT_MS = 3600000;

// Depth per configured concurrency value, so a model with its own concurrency
// cannot be throttled by whatever value another request happened to set.
const optimizerQueues = new Map();
let activeOptimizerCalls = 0;

function resolveConcurrency(config) {
    const raw = Number(config && config.optimizer_concurrency);
    if (!Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_OPTIMIZER_CONCURRENCY;
    }
    return Math.min(Math.max(Math.trunc(raw), 1), MAX_OPTIMIZER_CONCURRENCY);
}

function resolveQueueWaitMs(config) {
    const raw = Number(config && config.optimizer_queue_wait_ms);
    if (!Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_QUEUE_WAIT_MS;
    }
    return Math.min(Math.max(Math.trunc(raw), 10000), MAX_QUEUE_WAIT_MS);
}

// Effective in-flight limit: the largest concurrency any waiting request asked
// for, so one model's low setting cannot throttle another's high setting while
// the total still stays bounded.
function effectiveLimit() {
    let limit = 0;
    for (const value of optimizerQueues.keys()) {
        limit = Math.max(limit, value);
    }
    return limit;
}

function pumpOptimizerQueues() {
    for (const [limit, queue] of optimizerQueues) {
        while (queue.length > 0 && activeOptimizerCalls < effectiveLimit() && activeOptimizerCalls < limit) {
            const job = queue.shift();
            if (Date.now() - job.enqueuedAt > job.maxWaitMs) {
                job.reject(new Error("提示词优化排队超时"));
                continue;
            }
            activeOptimizerCalls += 1;
            job.run()
                .then(job.resolve, job.reject)
                .finally(() => {
                    activeOptimizerCalls -= 1;
                    pumpOptimizerQueues();
                });
        }
    }
}

// Runs `task` once a slot is free. Resolves the same way task() would.
// onStart receives how long the job waited in the queue.
function runQueued(task, limit, maxWaitMs, onStart) {
    return new Promise((resolve, reject) => {
        if (!optimizerQueues.has(limit)) {
            optimizerQueues.set(limit, []);
        }
        const enqueuedAt = Date.now();
        optimizerQueues.get(limit).push({
            run: () => {
                if (onStart) {
                    onStart(Date.now() - enqueuedAt);
                }
                return task();
            },
            resolve,
            reject,
            enqueuedAt,
            maxWaitMs
        });
        pumpOptimizerQueues();
    });
}

// Exposed for tests so queue state can be reset between cases.
function resetOptimizerQueue() {
    optimizerQueues.clear();
    activeOptimizerCalls = 0;
}

// Some optimizer deployments wrap a saturated upstream as HTTP 502 whose body
// still says "Concurrency limit exceeded". That is a transient queue-full answer,
// not a permanent failure, so it is worth retrying instead of falling back.
const CONCURRENCY_LIMIT_PATTERN = /concurrency\s*limit|too many requests|rate\s*limit|concurrent\s*requests|并发|限流|请求过多/i;
const MAX_CONCURRENCY_RETRIES = 3;
const CONCURRENCY_RETRY_DELAYS_MS = [2000, 6000];

function responseBodyText(data) {
    if (data === null || data === undefined) {
        return "";
    }
    if (typeof data === "string") {
        return data;
    }
    try {
        return JSON.stringify(data);
    } catch (error) {
        return "";
    }
}

function isConcurrencyLimited(error) {
    const response = error && error.response;
    if (!response) {
        return false;
    }
    // Only queue-full answers are retried; genuine 4xx/5xx errors are not.
    if (response.status !== 429 && response.status < 500) {
        return false;
    }
    return CONCURRENCY_LIMIT_PATTERN.test(responseBodyText(response.data));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestWithConcurrencyRetry(url, body, options, model, concurrency, maxWaitMs, onStart) {
    return runQueued(async () => {
        let attempt = 0;
        for (;;) {
            try {
                const response = await axios.post(url, body, options);
                if (attempt > 0) {
                    response.__optimizerAttempts = attempt + 1;
                }
                return response;
            } catch (error) {
                attempt += 1;
                if (attempt >= MAX_CONCURRENCY_RETRIES || !isConcurrencyLimited(error)) {
                    throw error;
                }
                const waitMs = CONCURRENCY_RETRY_DELAYS_MS[attempt - 1] || 6000;
                console.log(`[Prompt Optimizer] ${model} hit the optimizer concurrency limit; retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_CONCURRENCY_RETRIES})`);
                await sleep(waitMs);
            }
        }
    }, concurrency, maxWaitMs, onStart);
}

// Connection settings that a model may inherit from the saved global defaults.
const GLOBAL_OPTIMIZER_FIELDS = [
    "optimizer_base_url",
    "optimizer_api_key",
    "optimizer_model",
    "optimizer_json_mode",
    "optimizer_timeout_ms",
    "optimizer_send_media",
    "optimizer_allow_http"
];

// The saved global defaults are editable in the admin console. Rather than
// copying them onto every model, they are passed in at request time and used for
// any field the model leaves empty. An unset column arrives as undefined (from a
// missing property), null, or an empty string, and all three fall through.
function resolveOptimizerConfig(modelConfig, globalDefaults) {
    const model = modelConfig || {};
    const global = globalDefaults || {};
    const resolved = Object.assign({}, model);
    for (const field of GLOBAL_OPTIMIZER_FIELDS) {
        const value = model[field];
        if (value === undefined || value === null || value === "") {
            if (global[field] !== undefined && global[field] !== null && global[field] !== "") {
                resolved[field] = global[field];
            }
        }
    }
    return resolved;
}

function isEnabled(modelConfig) {
    if (!modelConfig) {
        return false;
    }
    const flag = modelConfig.optimize_prompt;
    return flag === 1 || flag === true || flag === "1";
}

function buildTrace(modelConfig, overrides) {
    return Object.assign({
        enabled: true,
        optimized: false,
        model: safeString(modelConfig && modelConfig.optimizer_model).trim() || DEFAULT_MODEL
    }, overrides);
}

function skippedTrace(modelConfig, reason) {
    return buildTrace(modelConfig, { optimized: false, reason });
}

function parseContentMeta(text) {
    try {
        const parsed = JSON.parse(text);
        return isObject(parsed) ? parsed : null;
    } catch (error) {
        return null;
    }
}

function toMeta(trace) {
    const meta = {
        enabled: true,
        optimized: Boolean(trace.optimized),
        model: trace.model,
        duration_ms: trace.duration_ms
    };
    if (trace.mode) meta.mode = trace.mode;
    if (trace.duration_sec !== undefined) meta.duration_sec = trace.duration_sec;
    if (trace.ratio) meta.ratio = trace.ratio;
    if (trace.shot_count !== undefined) meta.shot_count = trace.shot_count;
    if (trace.image_count) meta.image_count = trace.image_count;
    if (trace.attempts) meta.attempts = trace.attempts;
    if (trace.queue_wait_ms) meta.queue_wait_ms = trace.queue_wait_ms;
    if (trace.fallback) meta.fallback = true;
    if (trace.reason) meta.reason = trace.reason;
    return meta;
}

/**
 * Rewrite the caller's prompt through the optimizer service.
 *
 * @returns {Promise<{payload: object, trace: object}>} payload is always safe to
 *   forward upstream: on any failure it is the untouched input payload.
 */
async function optimizeRequestPayload(payload, modelConfig, globalDefaults) {
    const effective = modelConfig || {};
    if (!isEnabled(effective)) {
        return { payload, trace: { enabled: false } };
    }
    return optimizeWithConfig(payload, resolveOptimizerConfig(effective, globalDefaults));
}

/**
 * Same rewrite, but without the per-model enable check and with the endpoint,
 * key and model resolved from configuration or environment. Used by the gateway
 * request path and by the admin connectivity check.
 */
async function optimizeWithConfig(payload, config) {
    const effective = config || {};
    const baseUrl = safeString(effective.optimizer_base_url || process.env.OPTIMIZER_BASE_URL || DEFAULT_BASE_URL).trim();
    const endpoint = buildChatCompletionsUrl(baseUrl);
    const apiKey = safeString(effective.optimizer_api_key || process.env.OPTIMIZER_API_KEY || DEFAULT_API_KEY).trim();
    const model = safeString(effective.optimizer_model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const timeoutMs = resolveTimeout(effective);

    const extracted = extractPrompt(payload);
    const prompt = safeString(extracted.prompt).trim();
    if (!prompt) {
        return { payload, trace: skippedTrace(effective, "请求中没有可优化的提示词") };
    }
    if (!endpoint) {
        return { payload, trace: skippedTrace(effective, "未配置提示词优化接口地址") };
    }
    const allowInsecureHttp = isInsecureHttpAllowed(effective);
    if (!apiKey) {
        return { payload, trace: skippedTrace(effective, "未配置提示词优化接口密钥") };
    }
    if (isInsecureHttp(endpoint) && !allowInsecureHttp) {
        return {
            payload,
            trace: skippedTrace(effective, "优化服务使用 http，出于密钥安全默认不发送请求；如确需使用请在后台开启「允许 http 明文地址」")
        };
    }

    const started = Date.now();
    try {
        const mediaKinds = parseMediaKinds(effective.optimizer_send_media);
        const media = validateMedia(extracted.media.filter(item => mediaKinds.has(item.kind)));
        if (!media.ok) {
            throw new Error(media.reason || "媒体校验未通过");
        }

        const images = media.images.length > 0
            ? await resolveImages(media.images, DEFAULT_MEDIA_BYTES, Math.min(timeoutMs, 60000))
            : [];
        const extraParts = [];
        if (mediaKinds.has("video")) {
            extraParts.push(...buildContentParts(null, media.videos, "video"));
        }
        if (mediaKinds.has("audio")) {
            extraParts.push(...buildContentParts(null, media.audios, "audio"));
        }

        const jsonMode = effective.optimizer_json_mode === undefined
            ? true
            : Boolean(Number(effective.optimizer_json_mode));
        const systemPrompt = safeString(effective.optimizer_system_prompt).trim() || DEFAULT_SYSTEM_PROMPT;
        const userText = jsonMode ? `${prompt}\n\n${JSON_MODE_HINT}` : prompt;
        const userContent = [...buildContentParts(userText, images, "image"), ...extraParts];

        const requestBody = {
            model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent }
            ]
        };

        console.log(`[Prompt Optimizer] ${model} via ${endpoint} (images=${images.length}, json=${jsonMode}, timeout=${timeoutMs}ms)`);
        const queueSlot = resolveConcurrency(effective);
        const queueWaitLimitMs = resolveQueueWaitMs(effective);
        let queueWaitMs = 0;
        const response = await requestWithConcurrencyRetry(endpoint, requestBody, {
            headers: buildOptimizerHeaders(apiKey, endpoint, allowInsecureHttp),
            timeout: timeoutMs,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        }, model, queueSlot, queueWaitLimitMs, wait => { queueWaitMs = wait; });

        const optimized = parseOptimizerResponse(response.data);
        if (!optimized) {
            throw new Error("优化接口未返回可用的提示词");
        }

        const nextPayload = applyOptimizedPrompt(payload, optimized);
        const meta = parseContentMeta(safeString(response.data && response.data.choices && response.data.choices[0]
            && response.data.choices[0].message && response.data.choices[0].message.content).trim());
        const durationMs = Date.now() - started;

        console.log(`[Prompt Optimizer] done in ${durationMs}ms (${prompt.length} -> ${optimized.length} chars)`);
        const trace = buildTrace(effective, {
            optimized: true,
            model,
            duration_ms: durationMs,
            mode: meta && typeof meta.mode === "string" ? meta.mode : undefined,
            duration_sec: meta && typeof meta.duration_sec === "number" ? meta.duration_sec : undefined,
            ratio: meta && typeof meta.ratio === "string" ? meta.ratio : undefined,
            shot_count: meta && typeof meta.shot_count === "number" ? meta.shot_count : undefined,
            image_count: images.length || undefined,
            attempts: response.__optimizerAttempts,
            queue_wait_ms: queueWaitMs || undefined,
            original_prompt: prompt,
            optimized_prompt: optimized
        });
        return { payload: nextPayload, trace };
    } catch (error) {
        const reason = formatOptimizerError(error, timeoutMs);
        console.error(`[Prompt Optimizer] fallback to original prompt: ${reason}`);
        return {
            payload,
            trace: buildTrace(effective, {
                optimized: false,
                model,
                duration_ms: Date.now() - started,
                fallback: true,
                reason
            })
        };
    }
}

function formatOptimizerError(error, timeoutMs) {
    if (error && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) {
        return `提示词优化超时（${timeoutMs}ms）`;
    }
    const response = error && error.response;
    if (response) {
        const detail = isObject(response.data) && response.data.error
            ? (isObject(response.data.error) ? response.data.error.message : response.data.error)
            : (typeof response.data === "string" ? response.data.slice(0, 200) : "");
        return `提示词优化接口返回 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 200)}` : ""}`;
    }
    return safeString(error && error.message) || "提示词优化失败";
}

module.exports = {
    optimizeRequestPayload,
    optimizeWithConfig,
    resolveOptimizerConfig,
    resetOptimizerQueue,
    toMeta,
    isEnabled,
    buildChatCompletionsUrl,
    buildOptimizerHeaders,
    formatOptimizerError,
    parseMediaKinds,
    resolveTimeout,
    resolveConcurrency,
    resolveQueueWaitMs,
    GLOBAL_OPTIMIZER_FIELDS,
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MEDIA_BYTES,
    DEFAULT_OPTIMIZER_CONCURRENCY,
    DEFAULT_QUEUE_WAIT_MS
};
