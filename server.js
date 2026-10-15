const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const jsonata = require("jsonata");
const morgan = require("morgan");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const db = require("./db");
const { buildAuthHeaders } = require("./upstream-auth");
const { optimizeRequestPayload, toMeta } = require("./prompt-optimizer-service");

const app = express();
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "50mb" }));
app.use(morgan("dev"));

const MULTIPART_FORMATS = new Set(["multipart", "multipart/form-data", "form-data"]);
const MULTIPART_META_KEYS = new Set([
    "_route_path",
    "route_path",
    "_request_format",
    "request_format",
    "_content_type",
    "content_type",
    "files",
    "fields",
    "_file_fields",
    "file_fields",
    // Opt-in marker: a req_mapping that targets an SSE upstream (for example Gemini's
    // /v1beta/models/{model}:generateContent?alt=sse) sets this so the gateway pipes the
    // upstream body through verbatim instead of buffering it and re-mapping the response.
    // It is gateway metadata and must never be forwarded upstream.
    "_stream_passthrough"
]);

// Some upstreams (for example 豆包-backed video models) only return HEVC/H.265, which
// Chrome and Firefox cannot decode without extra platform support: the player stays at
// 0:00 and never starts. /content?format=h264 transcodes on demand (ffmpeg) and caches
// the rendition, so browsers get a playable H.264 file without changing the stored URL.
const CONTENT_CACHE_DIR = process.env.CONTENT_CACHE_DIR || path.join(__dirname, ".content-cache");
const H264_FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const H264_FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const H264_CRF = process.env.CONTENT_H264_CRF || "20";
const H264_PRESET = process.env.CONTENT_H264_PRESET || "veryfast";
const H264_AUDIO_BITRATE = process.env.CONTENT_H264_AUDIO_BITRATE || "128k";
const H264_TIMEOUT_MS = Number(process.env.CONTENT_H264_TIMEOUT_MS || 600000);
const H264_FORMATS = new Set(["h264", "avc", "avc1", "mp4"]);
// Concurrent requests for the same rendition share one ffmpeg run instead of spawning
// a process per range request.
const h264Jobs = new Map();

const adminRouter = require("./admin-api")(db);
app.use("/admin", adminRouter);
const { ensureSettingsTable, readOptimizerDefaults } = require("./gateway-settings");
app.get("/healthz", async (req, res) => {
    try {
        await db.get("SELECT 1 AS ok");
        res.json({ status: "ok" });
    } catch (error) {
        res.status(503).json({ status: "error", error: error.message });
    }
});

app.use("/", express.static(path.join(__dirname, "public")));

async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing Authorization header" });
    }
    const apiKey = authHeader.slice("Bearer ".length).trim();
    if (!apiKey) {
        return res.status(401).json({ error: "Missing Authorization header" });
    }

    try {
        const keyRecord = await db.get("SELECT * FROM gateway_keys WHERE api_key = ?", [apiKey]);
        if (keyRecord && keyRecord.status !== 1) {
            return res.status(401).json({ error: "Invalid or disabled API Key" });
        }
        if (keyRecord) {
            if (keyRecord.quota >= 0 && keyRecord.quota <= keyRecord.used_quota) {
                return res.status(402).json({ error: "Insufficient quota" });
            }
            req.gatewayKey = keyRecord;
            return next();
        }
        req.gatewayKey = null;
        req.passThroughKey = apiKey;
        next();
    } catch (error) {
        return res.status(500).json({ error: "Database error" });
    }
}

async function executeMapping(mappingTemplate, data) {
    try {
        const expression = jsonata(mappingTemplate);
        return await expression.evaluate(data);
    } catch(err) {
        console.error("Mapping error:", err.message);
        throw err;
    }
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (error) {
        return false;
    }
}

function getRequestFormat(payload) {
    if (!isObject(payload)) {
        return "json";
    }
    return String(payload._request_format || payload.request_format || payload._content_type || payload.content_type || "json").toLowerCase();
}

function isMultipartPayload(payload) {
    return MULTIPART_FORMATS.has(getRequestFormat(payload));
}

function getPayloadRoutePath(payload) {
    if (!isObject(payload)) {
        return null;
    }
    const routePath = payload._route_path || payload.route_path;
    if (!routePath) {
        return null;
    }
    const normalized = String(routePath);
    return normalized.startsWith("/") ? normalized : "/" + normalized;
}

function stripGatewayMeta(payload) {
    if (!isObject(payload)) {
        return payload;
    }
    return Object.fromEntries(Object.entries(payload).filter(([key]) => !MULTIPART_META_KEYS.has(key)));
}

function resolveUpstreamUrl(modelRecord, upstreamPayload) {
    return modelRecord.base_url + (getPayloadRoutePath(upstreamPayload) || modelRecord.route_path);
}

function appendFormField(form, key, value) {
    if (value === undefined) {
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(item => appendFormField(form, key, item));
        return;
    }
    if (value === null) {
        form.append(key, "");
        return;
    }
    form.append(key, isObject(value) ? JSON.stringify(value) : String(value));
}

function getFileExtension(contentType) {
    const type = String(contentType || "").split(";")[0].trim().toLowerCase();
    const extensions = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "application/pdf": "pdf",
        "text/plain": "txt"
    };
    return extensions[type] || "bin";
}

function sanitizeFilename(filename, fallback) {
    const candidate = filename ? path.basename(String(filename)) : fallback;
    return (candidate || fallback).replace(/[\r\n"]/g, "_");
}

function getFilenameFromUrl(fileUrl, fallback) {
    try {
        const parsed = new URL(fileUrl);
        const basename = path.basename(decodeURIComponent(parsed.pathname || ""));
        return sanitizeFilename(basename, fallback);
    } catch (error) {
        return fallback;
    }
}

function getFilenameFromDisposition(disposition) {
    if (!disposition) {
        return null;
    }
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
        return decodeURIComponent(utf8Match[1]);
    }
    const asciiMatch = disposition.match(/filename="?([^";]+)"?/i);
    return asciiMatch ? asciiMatch[1] : null;
}

function parseDataUrl(source) {
    const match = String(source).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match) {
        return null;
    }
    const contentType = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    const data = isBase64 ? match[3] : decodeURIComponent(match[3]);
    return {
        buffer: Buffer.from(data, isBase64 ? "base64" : "utf8"),
        contentType
    };
}

// Image bed used when a channel opts into base64 -> http conversion (both the request
// side, channels.convert_base64_to_url, and the response side,
// channels.convert_resp_base64_to_url). Zipline: POST multipart with an Authorization
// header carrying the token, answering either a plain-text URL
// (with x-zipline-no-json) or a JSON body with files[].url.
const IMAGE_BED_UPLOAD_URL = process.env.IMAGE_BED_UPLOAD_URL || "https://files.mmg.lat/api/upload";
const IMAGE_BED_TOKEN = process.env.IMAGE_BED_TOKEN || "zk_8a158b96b31bb2e30eeee88f41a2e6c7";
const IMAGE_BED_AUTH_HEADER = process.env.IMAGE_BED_AUTH_HEADER || "Authorization";
const IMAGE_BED_NO_JSON = process.env.IMAGE_BED_NO_JSON !== "0";

// The bed answers either the bare URL as text or JSON; accept both so switching a bed
// backend (or dropping the no-json header) cannot silently break uploads.
function extractImageBedUrl(response) {
    const data = response && response.data;
    if (typeof data === "string") {
        const text = data.trim();
        if (/^https?:\/\/\S+$/i.test(text)) {
            return text;
        }
        try {
            return extractImageBedUrl({ data: JSON.parse(text) });
        } catch (error) {
            return null;
        }
    }
    if (data && typeof data === "object") {
        if (typeof data.url === "string" && data.url.trim()) {
            return data.url.trim();
        }
        if (Array.isArray(data.files) && data.files[0] && typeof data.files[0].url === "string" && data.files[0].url.trim()) {
            return data.files[0].url.trim();
        }
    }
    return null;
}

function buildImageBedHeaders(form) {
    const headers = { ...form.getHeaders() };
    if (IMAGE_BED_TOKEN) {
        headers[IMAGE_BED_AUTH_HEADER] = IMAGE_BED_TOKEN;
    }
    if (IMAGE_BED_NO_JSON) {
        headers["x-zipline-no-json"] = "true";
    }
    return headers;
}

async function uploadBase64Image(source) {
    const parsed = parseDataUrl(source);
    if (!parsed) return source;
    const form = new FormData();
    // Zipline derives the stored extension from the uploaded file's name/content type, so
    // pass the truthful one instead of always claiming png.
    form.append("file", parsed.buffer, { filename: `image.${getFileExtension(parsed.contentType)}`, contentType: parsed.contentType });
    const response = await axios.post(IMAGE_BED_UPLOAD_URL, form, {
        headers: buildImageBedHeaders(form),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });
    const url = extractImageBedUrl(response);
    if (!url) {
        throw new Error("Image upload failed: invalid response");
    }
    return url;
}

async function convertBase64Images(value, key = "") {
    if (typeof value === "string") {
        if (/^data:image\//i.test(value)) return await uploadBase64Image(value);
        // OpenAI-compatible payloads may put raw image data in b64_json/base64.
        if (/^(images|image|b64_json|base64)$/i.test(key) && /^[A-Za-z0-9+/\s]+=*$/.test(value) && value.length > 32) {
            return await uploadBase64Image(`data:image/png;base64,${value.replace(/\s/g, "")}`);
        }
        return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map(item => convertBase64Images(item, key)));
    if (isObject(value)) {
        const entries = await Promise.all(Object.entries(value).map(async ([childKey, item]) => [childKey, await convertBase64Images(item, childKey)]));
        return Object.fromEntries(entries);
    }
    return value;
}

// Some upstreams answer with inline image data instead of a link. The downstream
// template expects an http URL, so channels can opt in to have every data URL /
// b64_json / raw base64 image in the mapped response uploaded to the image bed.
// Degrades to the original value when the upload fails, so a broken image bed can
// never turn a successful generation into an error.
const RESP_BASE64_KEYS = /^(b64_json|base64|image_base64|images|image_urls|image|url|data|content)$/i;

// Smallest raw-base64 image payload we are willing to treat as an image. Combined with the
// key whitelist and the base64 alphabet check this keeps ordinary prose and URLs out;
// anything shorter is left untouched (and would not decode into a usable image anyway).
const RESP_RAW_BASE64_MIN_LENGTH = 128;

function looksLikeRawBase64(value, key) {
    if (!RESP_BASE64_KEYS.test(key)) {
        return false;
    }
    const compact = value.replace(/\s/g, "");
    if (compact.length < RESP_RAW_BASE64_MIN_LENGTH) {
        return false;
    }
    return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

// Markdown image results (`![alt](data:image/png;base64,...)`) are unwrapped too: the
// downstream template expects an image link, not an image embedded in Markdown.
async function uploadInlineImage(source, contentTypeHint) {
    if (/^data:/i.test(source)) {
        return await uploadBase64Image(source);
    }
    const contentType = contentTypeHint && /^image\//i.test(contentTypeHint) ? contentTypeHint : "image/png";
    return await uploadBase64Image(`data:${contentType};base64,${source.replace(/\s/g, "")}`);
}

// Extension safety net for bed URLs that do not carry one (Zipline returns the truthful
// extension, but an older/other bed may hand back an extension-less link). Appends the
// sniffed extension to the pathname (before any query string); a URL whose path already
// carries an extension is left untouched.
function withTruthfulExtension(url, rawBase64) {
    if (!url || !/^https?:\/\//i.test(url)) {
        return url;
    }
    const extension = sniffImageExtension(rawBase64);
    if (!extension) {
        return url;
    }
    const [pathname, ...rest] = String(url).split("?");
    if (/\.[A-Za-z0-9]{2,5}$/.test(pathname)) {
        return url;
    }
    return `${pathname}.${extension}${rest.length ? `?${rest.join("?")}` : ""}`;
}

// The sniffed value is always a proper image extension, so the function never returns
// undefined; unknown payloads are treated as png, which is what the bed stores.
function sniffImageExtension(rawBase64) {
    if (rawBase64.startsWith("/9j/")) return "jpg";
    if (rawBase64.startsWith("R0lGOD")) return "gif";
    if (rawBase64.startsWith("UklGR")) return "webp";
    return "png";
}

function contentToRawBase64(source) {
    const parsed = parseDataUrl(source);
    return parsed ? parsed.buffer.toString("base64") : "";
}

async function tryConvertResponseImages(responseBody, binding) {
    if (!binding || !Number(binding.convert_resp_base64_to_url)) {
        return responseBody;
    }
    try {
        return await convertMappedResponseImages(responseBody);
    } catch (error) {
        console.error("[Gateway Response Base64] conversion failed, returning upstream payload as-is:", error.message);
        return responseBody;
    }
}

async function convertMappedResponseImages(value, key = "") {
    if (typeof value === "string") {
        const trimmed = value.trim();
        const markdownMatch = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(trimmed);
        if (markdownMatch && /^data:image\//i.test(markdownMatch[1])) {
            // Return the bare link: downstream expects an image URL, not a Markdown image.
            const uploaded = await uploadInlineImage(markdownMatch[1]);
            return uploaded ? withTruthfulExtension(uploaded, contentToRawBase64(markdownMatch[1])) : value;
        }
        if (/^data:image\//i.test(trimmed)) {
            const uploaded = await uploadInlineImage(trimmed);
            return uploaded ? withTruthfulExtension(uploaded, contentToRawBase64(trimmed)) : value;
        }
        if (looksLikeRawBase64(value, key)) {
            const uploaded = await uploadInlineImage(value, "image/png");
            return uploaded ? withTruthfulExtension(uploaded, value.replace(/\s/g, "")) : value;
        }
        return value;
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map(item => convertMappedResponseImages(item, key)));
    }
    if (isObject(value)) {
        const entries = await Promise.all(Object.entries(value).map(async ([childKey, item]) => [childKey, await convertMappedResponseImages(item, childKey)]));
        return Object.fromEntries(entries);
    }
    return value;
}

async function appendFilePart(form, field, fileSpec, index = 0) {
    const spec = isObject(fileSpec) ? fileSpec : { source: fileSpec };
    const source = spec.source || spec.url || spec.base64 || spec.data;
    if (!source) {
        return;
    }

    const fallbackName = `${field}-${index + 1}.bin`;
    const contentType = spec.content_type || spec.contentType || "application/octet-stream";

    if (typeof source === "string" && source.startsWith("data:")) {
        const parsed = parseDataUrl(source);
        if (!parsed) {
            throw new Error(`Invalid data URL for multipart field ${field}`);
        }
        const filename = sanitizeFilename(spec.filename, `${field}-${index + 1}.${getFileExtension(parsed.contentType)}`);
        form.append(field, parsed.buffer, { filename, contentType: parsed.contentType });
        return;
    }

    if (typeof source === "string" && /^https:\/\//i.test(source)) {
        const fileRes = await axios.get(source, {
            responseType: "stream",
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        const responseType = fileRes.headers["content-type"] || contentType;
        const dispositionName = getFilenameFromDisposition(fileRes.headers["content-disposition"]);
        const filename = sanitizeFilename(spec.filename || dispositionName || getFilenameFromUrl(source, fallbackName), fallbackName);
        form.append(field, fileRes.data, { filename, contentType: responseType });
        return;
    }

    if (typeof source === "string" && /^http:\/\//i.test(source)) {
        throw new Error(`Only https file URLs are supported for multipart field ${field}`);
    }

    const filename = sanitizeFilename(spec.filename, `${field}-${index + 1}.${getFileExtension(contentType)}`);
    const encoding = spec.encoding || "base64";
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source), encoding);
    form.append(field, buffer, { filename, contentType });
}

function normalizeFileEntries(files) {
    if (!files) {
        return [];
    }
    if (Array.isArray(files)) {
        return files.flatMap(item => {
            if (!isObject(item)) {
                return [];
            }
            const field = item.field || item.name;
            if (!field) {
                return [];
            }
            const values = item.items || item.values || item.files;
            if (Array.isArray(values)) {
                return values.map(value => ({ field, value: isObject(value) ? { ...value, field } : { source: value } }));
            }
            return [{ field, value: item }];
        });
    }
    if (isObject(files)) {
        return Object.entries(files).flatMap(([field, value]) => {
            const values = Array.isArray(value) ? value : [value];
            return values.map(item => ({ field, value: isObject(item) ? { ...item, field } : { source: item } }));
        });
    }
    return [];
}

async function buildMultipartRequest(payload) {
    const form = new FormData();
    const fieldValues = isObject(payload.fields) ? payload.fields : Object.fromEntries(
        Object.entries(payload).filter(([key]) => !MULTIPART_META_KEYS.has(key))
    );
    const fileFields = payload._file_fields || payload.file_fields || [];
    const fileFieldSet = new Set(Array.isArray(fileFields) ? fileFields : [fileFields]);

    Object.entries(fieldValues).forEach(([key, value]) => {
        if (!fileFieldSet.has(key)) {
            appendFormField(form, key, value);
        }
    });

    const fileEntries = normalizeFileEntries(payload.files);
    fileFieldSet.forEach(field => {
        const value = payload[field] || (payload.fields && payload.fields[field]);
        const values = Array.isArray(value) ? value : [value];
        values.filter(item => item !== undefined).forEach(item => fileEntries.push({ field, value: item }));
    });

    for (let index = 0; index < fileEntries.length; index += 1) {
        await appendFilePart(form, fileEntries[index].field, fileEntries[index].value, index);
    }

    return form;
}

async function buildPostOptions(upstreamKey, upstreamPayload, authType) {
    const headers = buildAuthHeaders(upstreamKey, authType);
    if (!isMultipartPayload(upstreamPayload)) {
        return { data: stripGatewayMeta(upstreamPayload), options: { headers } };
    }

    const form = await buildMultipartRequest(upstreamPayload);
    return {
        data: form,
        options: {
            headers: { ...headers, ...form.getHeaders() },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        }
    };
}

async function loadActiveBindings(modelName) {
    return db.all(`SELECT
            b.*,
            b.id AS binding_id,
            lm.id AS logical_model_id,
            lm.model_name,
            lm.optimize_prompt,
            lm.optimizer_base_url,
            lm.optimizer_api_key,
            lm.optimizer_model,
            lm.optimizer_system_prompt,
            lm.optimizer_json_mode,
            lm.optimizer_timeout_ms,
            lm.optimizer_send_media,
            lm.optimizer_allow_http,
            lm.optimizer_debug,
            c.base_url,
            c.api_key AS channel_api_key,
            c.auth_type AS channel_auth_type,
            c.convert_base64_to_url,
            c.convert_resp_base64_to_url,
            c.name AS channel_name
        FROM logical_models lm
        JOIN model_bindings b ON b.logical_model_id = lm.id
        JOIN channels c ON c.id = b.channel_id
        WHERE lm.model_name = ?
          AND lm.status = 1
          AND b.status = 1
          AND c.status = 1`, [modelName]);
}

function selectBinding(bindings) {
    const totalWeight = bindings.reduce((sum, binding) => sum + Math.max(Number(binding.weight || 1), 1), 0);
    let target = Math.random() * totalWeight;
    for (const binding of bindings) {
        target -= Math.max(Number(binding.weight || 1), 1);
        if (target <= 0) {
            return binding;
        }
    }
    return bindings[0];
}

async function selectModelBinding(modelName) {
    const bindings = await loadActiveBindings(modelName);
    if (bindings.length === 0) {
        return null;
    }
    return selectBinding(bindings);
}

function tryPassthroughUpstreamError(res, error, passthrough) {
    if (passthrough && error.response) {
        res.status(error.response.status).json(error.response.data);
        return true;
    }
    return false;
}

function isOptimizerDebugEnabled(binding) {
    return Boolean(binding && Number(binding.optimizer_debug) === 1);
}

// The saved global optimizer defaults are merged into each request so a model
// only needs to switch the feature on when the connection is configured globally.
// Read failure must never break a request, so it degrades to model-only settings.
async function loadGlobalOptimizerDefaults() {
    try {
        return await readOptimizerDefaults(db);
    } catch (error) {
        console.error("[Prompt Optimizer] failed to read global defaults:", error.message);
        return {};
    }
}

// Downstream OpenAI-compatible callers ask for `stream: true`. The gateway normally buffers
// the upstream response and re-maps it with resp_mapping (which cannot express SSE), so a
// binding whose req_mapping opts in with `"_stream_passthrough": true` gets its upstream body
// piped through verbatim instead. Every other binding keeps the old buffered behaviour.
function wantsStreamedResponse(body) {
    if (!isObject(body)) {
        return false;
    }
    return body.stream === true || String(body.stream).toLowerCase() === "true";
}

function isStreamPassthroughPayload(payload) {
    return isObject(payload) && payload._stream_passthrough === true;
}

async function readStreamAsText(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

// Pipes the upstream body (SSE or otherwise) to the downstream response untouched, keeping
// the upstream content type. Non-2xx answers are buffered so error_passthrough still works.
async function streamMappedResponse(postRequest, upstreamUrl, res, binding, logLabel) {
    const upstreamRes = await axios.post(upstreamUrl, postRequest.data, {
        ...postRequest.options,
        responseType: "stream",
        validateStatus: () => true,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 0
    });

    if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
        const text = await readStreamAsText(upstreamRes.data);
        let payload = text;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            // Keep the raw body when the upstream error is not JSON.
        }
        if (binding.error_passthrough) {
            return res.status(upstreamRes.status).json(payload);
        }
        return res.status(502).json({ error: "Upstream request failed", upstream_status: upstreamRes.status });
    }

    if (upstreamRes.headers["content-type"]) {
        res.setHeader("Content-Type", upstreamRes.headers["content-type"]);
    }
    if (upstreamRes.headers["cache-control"]) {
        res.setHeader("Cache-Control", upstreamRes.headers["cache-control"]);
    }
    // Disable buffering in front proxies (nginx) so SSE chunks reach the client immediately.
    res.setHeader("X-Accel-Buffering", "no");

    const upstreamStream = upstreamRes.data;
    const cleanup = () => {
        if (!upstreamStream.destroyed) {
            upstreamStream.destroy();
        }
    };
    res.on("close", cleanup);
    upstreamStream.on("error", error => {
        console.error(`[${logLabel}] upstream stream error:`, error.message);
        cleanup();
        if (!res.writableEnded) {
            res.end();
        }
    });

    console.log(`[${logLabel}] Streaming upstream ${upstreamRes.status} ${upstreamRes.headers["content-type"] || ""} to downstream`);
    res.status(upstreamRes.status);
    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }
    upstreamStream.pipe(res);
}

async function sendMappedPost(binding, body, logLabel, options = {}) {
    // Prompt optimization runs on the caller's original body so the optimizer
    // receives inline image data, before any channel-level base64 -> URL upload.
    const globalDefaults = await loadGlobalOptimizerDefaults();
    const { payload, trace } = await optimizeRequestPayload(body, binding, globalDefaults);
    const inputBody = binding.convert_base64_to_url ? await convertBase64Images(payload) : payload;
    const upstreamPayload = await executeMapping(binding.req_mapping, inputBody);
    const upstreamKey = options.upstreamKey || binding.api_key || binding.channel_api_key;
    const upstreamUrl = resolveUpstreamUrl(binding, upstreamPayload);

    console.log(`[${logLabel}] Routing ${binding.model_name} to ${binding.channel_name}: ${upstreamUrl}`);
    const postRequest = await buildPostOptions(upstreamKey, upstreamPayload, binding.channel_auth_type);
    if (options.streamTarget && isStreamPassthroughPayload(upstreamPayload)) {
        await streamMappedResponse(postRequest, upstreamUrl, options.streamTarget, binding, logLabel);
        return { streamed: true, upstreamKey, optimizerTrace: trace, gwResponse: null };
    }
    const upstreamRes = await axios.post(upstreamUrl, postRequest.data, postRequest.options);
    const mappedResponse = await executeMapping(binding.resp_mapping, upstreamRes.data);
    // Channels that opt in get inline base64 answers rewritten to image-bed http links,
    // so downstream always receives the same shape regardless of the upstream format.
    const gwResponse = await tryConvertResponseImages(mappedResponse, binding);

    return { gwResponse, upstreamKey, optimizerTrace: trace, streamed: false };
}

// The optimizer trace is only reported to callers when the model enables debug,
// or when the step was enabled but could not run (so failures are discoverable).
function attachOptimizerDebug(responseBody, binding, trace) {
    if (!trace || !trace.enabled) {
        return responseBody;
    }
    if (!isOptimizerDebugEnabled(binding) && trace.optimized) {
        return responseBody;
    }
    const current = isObject(responseBody) && isObject(responseBody.prompt_optimizer)
        ? responseBody.prompt_optimizer
        : null;
    return { ...responseBody, prompt_optimizer: current || toMeta(trace) };
}

async function loadLegacyPollRuntime(taskRecord) {
    const modelRecord = await db.get("SELECT m.*, c.base_url, c.api_key as channel_api_key, c.auth_type FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?", [taskRecord.model_id]);
    if (!modelRecord) {
        return null;
    }
    return {
        base_url: modelRecord.base_url,
        poll_path: modelRecord.poll_path,
        poll_mapping: modelRecord.poll_mapping,
        upstream_key: modelRecord.api_key || modelRecord.channel_api_key,
        auth_type: modelRecord.auth_type
    };
}

// Downstream contract for a video task is `error: { code, message }` (or null).
// The shape is produced by each binding's poll_mapping JSONata, so older channel
// configs still emit the legacy flat form (`error: "<text>"` plus a top-level
// `error_code`). Normalizing here - rather than only in the mappings - also fixes
// tasks whose poll_mapping_snapshot was frozen before a mapping was corrected.
const VIDEO_ERROR_CODES = new Set([
    "video_generation_failed",
    "video_generation_cancelled",
    "reference_image_download_failed",
    "gpu_out_of_memory",
    "content_moderation"
]);

function pickErrorText(value) {
    if (typeof value === "string") {
        return value.trim() || null;
    }
    if (!isObject(value)) {
        return null;
    }
    for (const key of ["message", "msg", "error", "detail", "reason"]) {
        const text = value[key];
        if (typeof text === "string" && text.trim()) {
            return text.trim();
        }
    }
    return null;
}

function pickErrorCode(value) {
    if (!isObject(value)) {
        return null;
    }
    for (const key of ["code", "error_code", "type"]) {
        const code = value[key];
        if (typeof code === "string" && code.trim()) {
            return code.trim();
        }
    }
    return null;
}

function normalizeVideoError(pollResult) {
    if (!isObject(pollResult)) {
        return pollResult;
    }

    const raw = pollResult.error;
    const message = pickErrorText(raw);
    let code = pickErrorCode(raw);
    if (!code) {
        code = pickErrorCode({ code: pollResult.error_code, type: pollResult.error_type });
    }

    // A failed task must always describe itself; a non-failed one carries no error.
    if (!message && pollResult.status !== "failed") {
        pollResult.error = null;
        pollResult.error_code = null;
        return pollResult;
    }

    if (!VIDEO_ERROR_CODES.has(code)) {
        code = "video_generation_failed";
    }
    pollResult.error = { code, message: message || "Video generation failed" };
    // Keep the legacy flat field as a mirror so existing clients stay consistent.
    pollResult.error_code = code;
    return pollResult;
}

async function pollAsyncTask(taskRecord) {
    const runtime = (taskRecord.binding_id || taskRecord.upstream_base_url || taskRecord.poll_path_snapshot || taskRecord.poll_mapping_snapshot || taskRecord.upstream_api_key_snapshot)
        ? {
            base_url: taskRecord.upstream_base_url,
            poll_path: taskRecord.poll_path_snapshot,
            poll_mapping: taskRecord.poll_mapping_snapshot,
            upstream_key: taskRecord.upstream_api_key_snapshot,
            auth_type: taskRecord.upstream_auth_type_snapshot
        }
        : await loadLegacyPollRuntime(taskRecord);

    if (!runtime) {
        throw new Error("Task binding not found");
    }

    let upPollPath = runtime.poll_path || "/";
    upPollPath = upPollPath.replace("${up_task_id}", taskRecord.up_task_id);

    const upstreamRes = await axios.get(runtime.base_url + upPollPath, {
        headers: buildAuthHeaders(runtime.upstream_key, runtime.auth_type)
    });

    const pollResult = normalizeVideoError(await executeMapping(runtime.poll_mapping, upstreamRes.data));
    pollResult.id = taskRecord.gw_task_id;
    pollResult.task_id = taskRecord.gw_task_id;
    return pollResult;
}

async function getTaskErrorPassthrough(taskRecord) {
    try {
        if (!taskRecord || !taskRecord.binding_id) return false;
        const binding = await db.get("SELECT error_passthrough FROM model_bindings WHERE id = ?", [taskRecord.binding_id]);
        return Boolean(binding && binding.error_passthrough);
    } catch (error) {
        return false;
    }
}

async function updateTaskStatus(taskRecord, pollResult) {
    if (pollResult.status === "completed") {
        await db.run("UPDATE async_tasks SET status = 'completed' WHERE gw_task_id = ? AND status <> 'completed'", [taskRecord.gw_task_id]);
    } else if (pollResult.status === "failed") {
        const result = await db.run("UPDATE async_tasks SET status = 'failed', quota_released = 1 WHERE gw_task_id = ? AND quota_released = 0", [taskRecord.gw_task_id]);
        if (result.affectedRows > 0 && taskRecord.gw_key_id) {
            await db.run("UPDATE gateway_keys SET used_quota = GREATEST(used_quota - 1, 0) WHERE id = ?", [taskRecord.gw_key_id]);
        }
    }
}

async function isPollThrottleEnabled(taskRecord) {
    if (taskRecord.poll_throttle_snapshot !== null && taskRecord.poll_throttle_snapshot !== undefined) {
        return Boolean(taskRecord.poll_throttle_snapshot);
    }
    if (!taskRecord.binding_id) {
        return false;
    }
    const binding = await db.get("SELECT poll_throttle FROM model_bindings WHERE id = ?", [taskRecord.binding_id]);
    return Boolean(binding && binding.poll_throttle);
}

async function claimPollSlot(taskRecord) {
    const intervalSec = Number(process.env.POLL_MIN_INTERVAL_SECONDS || 6);
    const result = await db.run(
        "UPDATE async_tasks SET last_poll_at = NOW() WHERE gw_task_id = ? AND (last_poll_at IS NULL OR last_poll_at <= NOW() - INTERVAL ? SECOND)",
        [taskRecord.gw_task_id, intervalSec]
    );
    return result.affectedRows > 0;
}

function isPollRateLimited(error) {
    const res = error.response;
    if (res && res.status === 429) {
        return true;
    }
    const data = res && res.data;
    if (!data) {
        return false;
    }
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return /rate[_\s-]?limit/i.test(text);
}

function buildQueuedPollResponse(taskRecord) {
    return {
        id: taskRecord.gw_task_id,
        task_id: taskRecord.gw_task_id,
        status: "queued",
        progress: 0
    };
}

async function shouldProxyTaskContent(taskRecord) {
    if (taskRecord.proxy_content_snapshot !== null && taskRecord.proxy_content_snapshot !== undefined) {
        return Boolean(taskRecord.proxy_content_snapshot);
    }
    if (!taskRecord.binding_id) {
        return false;
    }
    const binding = await db.get("SELECT proxy_content FROM model_bindings WHERE id = ?", [taskRecord.binding_id]);
    return Boolean(binding && binding.proxy_content);
}

function getGatewayContentUrl(req, taskId) {
    return req.protocol + "://" + req.get("host") + "/v1/videos/" + encodeURIComponent(taskId) + "/content";
}

function applyProxyContentUrl(req, taskRecord, pollResult) {
    if (pollResult.status !== "completed") {
        return;
    }
    const contentUrl = getGatewayContentUrl(req, taskRecord.gw_task_id);
    pollResult.video_url = contentUrl;
    pollResult.result_url = contentUrl;
    if (typeof pollResult.object === "string" && isHttpUrl(pollResult.object)) {
        pollResult.object = contentUrl;
    }
}

async function proxyVideoContent(req, res, taskRecord, videoUrl) {
    if (!isHttpUrl(videoUrl)) {
        return res.status(502).json({ error: "Upstream video URL is missing or invalid" });
    }

    // Result URLs may carry their own token on a different provider's host.
    // Send channel credentials immediately only to the original upstream origin.
    const sameOrigin = isHttpUrl(taskRecord.upstream_base_url)
        && new URL(videoUrl).origin === new URL(taskRecord.upstream_base_url).origin;
    const channelHeaders = sameOrigin
        ? buildAuthHeaders(taskRecord.upstream_api_key_snapshot, taskRecord.upstream_auth_type_snapshot)
        : {};
    const headers = { ...channelHeaders };
    if (req.headers.range) {
        headers.Range = req.headers.range;
    }
    if (req.headers["if-range"]) {
        headers["If-Range"] = req.headers["if-range"];
    }

    const requestVideo = (url, extraHeaders = {}) => axios.get(url, {
        headers: { ...headers, ...extraHeaders },
        responseType: "stream",
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: Number(process.env.UPSTREAM_VIDEO_TIMEOUT_MS || 30000),
        validateStatus: () => true
    });
    let contentUrl = videoUrl;
    let upstreamRes = await requestVideo(contentUrl);

    // Some providers return signed cross-origin URLs, while others require
    // the original channel credential. Try the URL first, then fall back to
    // the saved credential only when the provider explicitly asks for it.
    const rejected = () => upstreamRes.status === 401 || upstreamRes.status === 403;
    if (!sameOrigin && rejected() && taskRecord.upstream_api_key_snapshot) {
        upstreamRes.data.destroy();
        upstreamRes = await requestVideo(contentUrl, buildAuthHeadersFor(taskRecord));
    }

    // Opt-in per channel (channels.content_fallback_enabled) or via the global
    // CONTENT_FALLBACK_ENABLED flag: third-party CDN links can expire or reject gateway
    // requests (observed as 403 Forbidden) even though the upstream's own download
    // endpoint still serves the very same task. Channels that did not opt in keep the
    // previous behaviour exactly.
    const stationUrl = buildStationDownloadUrl(taskRecord);
    if (rejected() && stationUrl && stationUrl !== contentUrl && await shouldUseContentFallback(taskRecord)) {
        upstreamRes.data.destroy();
        const retryRes = await requestVideo(stationUrl, buildAuthHeadersFor(taskRecord));
        if (retryRes.status >= 200 && retryRes.status < 300) {
            console.warn("[Gateway Video Proxy Fallback]", upstreamRes.status, "->", retryRes.status, stationUrl);
            upstreamRes = retryRes;
            contentUrl = stationUrl;
        } else {
            retryRes.data.resume();
            console.error("[Gateway Video Proxy Fallback Failed]", upstreamRes.status, "->", retryRes.status, stationUrl);
        }
    }

    if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
        upstreamRes.data.resume();
        console.error("[Gateway Video Proxy Upstream Error]", upstreamRes.status, contentUrl, "range=", headers.Range || "-");
        return res.status(502).json({
            error: "Upstream video content request failed",
            upstream_status: upstreamRes.status
        });
    }

    [
        "accept-ranges",
        "cache-control",
        "content-disposition",
        "content-length",
        "content-range",
        "content-type",
        "etag",
        "last-modified"
    ].forEach(name => {
        if (upstreamRes.headers[name] !== undefined) {
            res.setHeader(name, upstreamRes.headers[name]);
        }
    });
    res.status(upstreamRes.status);

    upstreamRes.data.on("error", error => {
        console.error("[Gateway Video Stream Error]", error.message);
        if (!res.headersSent) {
            res.status(502).json({ error: "Upstream video stream failed" });
        } else {
            res.destroy(error);
        }
    });
    res.on("close", () => {
        if (!res.writableEnded && !upstreamRes.data.destroyed) {
            upstreamRes.data.destroy();
        }
    });
    upstreamRes.data.pipe(res);
}

function wantsH264(req) {
    const raw = req.query && req.query.format;
    if (raw === undefined || raw === null || raw === "") {
        return false;
    }
    return H264_FORMATS.has(String(raw).trim().toLowerCase());
}

function h264CachePaths(taskId) {
    const safe = crypto.createHash("sha256").update(String(taskId)).digest("hex");
    return {
        dir: CONTENT_CACHE_DIR,
        result: path.join(CONTENT_CACHE_DIR, `${safe}.mp4`),
        part: path.join(CONTENT_CACHE_DIR, `${safe}.part.mp4`)
    };
}

async function fileSizeIfPresent(filePath) {
    try {
        const info = await fsp.stat(filePath);
        return info.isFile() ? info.size : 0;
    } catch (error) {
        return 0;
    }
}

// Returns the first stream video codec of a local file ("hevc", "h264", ...), or null
// when it cannot be determined (ffprobe missing, unreadable file).
async function probeVideoCodec(filePath) {
    const size = await fileSizeIfPresent(filePath);
    if (!size) {
        return null;
    }
    return new Promise(resolve => {
        const child = spawn(H264_FFPROBE_PATH, [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=noprint_wrappers=1:nokey=1",
            filePath
        ], { stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
        child.stdout.on("data", chunk => {
            stdout += chunk.toString();
        });
        child.on("error", () => {
            clearTimeout(timer);
            resolve(null);
        });
        child.on("close", () => {
            clearTimeout(timer);
            const name = stdout.trim().split(/\s+/)[0];
            resolve(name ? name.toLowerCase() : null);
        });
    });
}

function isTranscodeError(error) {
    return Boolean(error && (error.upstreamStatus !== undefined
        || /ffmpeg|ffprobe|transcod|rendition/i.test(String(error.message || ""))));
}

// Browser-playable codecs: anything else (HEVC/H.265 in practice) needs a rendition.
function isBrowserPlayableCodec(codec) {
    return Boolean(codec) && /^(avc|h264|vp8|vp9|av1)/.test(codec);
}

function cachedSourcePath(taskId) {
    return `${h264CachePaths(taskId).part}.src`;
}

// Downloads the upstream rendition and publishes a browser-playable mp4 into the cache:
// transcodes to H.264/AAC with a fast-start moov, or copies as-is when the source is
// already H.264 (nothing to gain from re-encoding).
async function buildH264Rendition(streamFactory, taskId) {
    const { dir, result, part } = h264CachePaths(taskId);
    await fsp.mkdir(dir, { recursive: true });
    const rawPath = `${part}.src`;

    try {
        const upstreamRes = await streamFactory();
        if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
            upstreamRes.data.resume();
            const error = new Error(`Upstream source request failed with ${upstreamRes.status}`);
            error.upstreamStatus = upstreamRes.status;
            throw error;
        }
        await new Promise((resolve, reject) => {
            const sink = fs.createWriteStream(rawPath);
            upstreamRes.data.on("error", reject);
            sink.on("error", reject);
            sink.on("finish", resolve);
            upstreamRes.data.pipe(sink);
        });

        const sourceCodec = await probeVideoCodec(rawPath);
        if (isBrowserPlayableCodec(sourceCodec)) {
            await fsp.rename(rawPath, result);
            const copied = await fileSizeIfPresent(result);
            console.log("[Gateway H264 Passthrough]", taskId, sourceCodec, `${copied} bytes`);
            return result;
        }
        console.log("[Gateway H264 Transcode Start]", taskId, sourceCodec || "unknown codec");

        await new Promise((resolve, reject) => {
            const args = [
                "-hide_banner", "-loglevel", "error", "-y",
                "-i", rawPath,
                "-c:v", "libx264", "-preset", H264_PRESET, "-crf", String(H264_CRF),
                "-pix_fmt", "yuv420p", "-tag:v", "avc1",
                "-c:a", "aac", "-b:a", H264_AUDIO_BITRATE,
                "-movflags", "+faststart",
                part
            ];
            const child = spawn(H264_FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`ffmpeg timed out after ${H264_TIMEOUT_MS}ms`));
            }, H264_TIMEOUT_MS);
            child.stderr.on("data", chunk => {
                stderr = (stderr + chunk.toString()).slice(-2000);
            });
            child.on("error", error => {
                clearTimeout(timer);
                reject(error.code === "ENOENT"
                    ? new Error(`ffmpeg not found (${H264_FFMPEG_PATH}); install it or set FFMPEG_PATH`)
                    : error);
            });
            child.on("close", code => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
                }
            });
        });

        const size = await fileSizeIfPresent(part);
        if (size <= 0) {
            throw new Error("ffmpeg produced an empty file");
        }
        await fsp.rename(part, result);
        console.log("[Gateway H264 Transcode Done]", taskId, `${size} bytes`);
        return result;
    } catch (error) {
        await fsp.rm(rawPath, { force: true }).catch(() => {});
        await fsp.rm(part, { force: true }).catch(() => {});
        throw error;
    }
}

// Serializes concurrent requests for the same rendition.
async function ensureH264Rendition(streamFactory, taskId) {
    const { result } = h264CachePaths(taskId);
    if (await fileSizeIfPresent(result)) {
        return result;
    }
    const running = h264Jobs.get(taskId);
    if (running) {
        return running;
    }
    const job = buildH264Rendition(streamFactory, taskId).finally(() => h264Jobs.delete(taskId));
    h264Jobs.set(taskId, job);
    return job;
}

// Serves a locally cached mp4 with Range and conditional-request support.
async function sendLocalVideoFile(req, res, filePath) {
    const info = await fsp.stat(filePath);
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", info.mtime.toUTCString());
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) {
        return res.status(304).end();
    }
    res.sendFile(filePath, {
        acceptRanges: true,
        cacheControl: false,
        etag: false,
        lastModified: false,
        dotfiles: "deny"
    }, error => {
        if (error && !res.headersSent) {
            res.status(error.code === "ECONNABORTED" || res.headersSent ? 200 : 500).end();
        }
    });
}

async function shouldUseContentFallback(taskRecord) {
    // Global master switch (default off) or an explicit per-channel opt-in.
    if (process.env.CONTENT_FALLBACK_ENABLED === "1") {
        return true;
    }
    if (!taskRecord || !taskRecord.channel_id) {
        return false;
    }
    try {
        const channel = await db.get("SELECT content_fallback_enabled FROM channels WHERE id = ?", [taskRecord.channel_id]);
        return Boolean(channel && channel.content_fallback_enabled);
    } catch (error) {
        return false;
    }
}

function buildAuthHeadersFor(taskRecord) {
    return buildAuthHeaders(taskRecord.upstream_api_key_snapshot, taskRecord.upstream_auth_type_snapshot);
}

// The upstream station download endpoint: the same task, served by the upstream itself.
// Only used when the channel opts into the content fallback (third-party CDN result URLs
// can expire or answer 403 while the upstream still has the video).
function buildStationDownloadUrl(taskRecord) {
    if (!isHttpUrl(taskRecord.upstream_base_url) || !taskRecord.up_task_id) {
        return null;
    }
    return `${String(taskRecord.upstream_base_url).replace(/\/+$/, "")}/v1/tasks/${encodeURIComponent(taskRecord.up_task_id)}/download`;
}

function buildVideoContentFetcher(taskRecord, videoUrl) {
    const headers = buildAuthHeadersFor(taskRecord);
    const stationUrl = buildStationDownloadUrl(taskRecord);
    const request = (url, extraHeaders = {}) => axios.get(url, {
        headers: { ...headers, ...extraHeaders },
        responseType: "stream",
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: Number(process.env.UPSTREAM_VIDEO_TIMEOUT_MS || 30000),
        validateStatus: () => true
    });
    const useFallback = fallbackEnabled => Boolean(fallbackEnabled && stationUrl && stationUrl !== videoUrl);
    return async () => {
        let response = await request(videoUrl);
        const rejected = () => response.status === 401 || response.status === 403;
        if (rejected() && useFallback(await shouldUseContentFallback(taskRecord))) {
            response.data.resume();
            const retry = await request(stationUrl);
            if (retry.status >= 200 && retry.status < 300) {
                console.warn("[Gateway Video Content Fallback]", response.status, "->", retry.status, stationUrl);
                return retry;
            }
            console.error("[Gateway Video Content Fallback Failed]", response.status, "->", retry.status, stationUrl);
            response = retry;
        }
        return response;
    };
}

app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    let binding;
    try {
        binding = await selectModelBinding(req.body.model);
        if (!binding) {
            return res.status(503).json({ error: "Model not found, disabled, or has no available channel" });
        }

        if (req.gatewayKey) {
            await db.run('UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?', [req.gatewayKey.id]);
        }
        const result = await sendMappedPost(binding, req.body, "Gateway POST completions", {
            upstreamKey: req.passThroughKey,
            // Only relevant for bindings whose req_mapping opts into stream passthrough.
            streamTarget: wantsStreamedResponse(req.body) ? res : null
        });
        if (result.streamed) {
            return;
        }
        return res.json(attachOptimizerDebug(result.gwResponse, binding, result.optimizerTrace));
    } catch (error) {
        // A streamed response may already have its headers (and bytes) on the wire; in that
        // case the only sensible thing left is to end the response.
        if (res.headersSent) {
            console.error("[Gateway POST completions Stream Error]", error.message);
            return res.end();
        }
        if (tryPassthroughUpstreamError(res, error, binding && binding.error_passthrough)) return;
        console.error("[Gateway POST completions Error]", error.response ? error.response.data : error.message);
        return res.status(500).json({ error: "Upstream request failed", details: error.message });
    }
});

app.post(["/v1/images/generations", "/v1/images/edits"], authMiddleware, async (req, res) => {
    let binding;
    try {
        binding = await selectModelBinding(req.body.model);
        if (!binding) {
            return res.status(503).json({ error: "Model not found, disabled, or has no available channel" });
        }

        const { gwResponse, optimizerTrace } = await sendMappedPost(binding, req.body, "Gateway POST images", {
            upstreamKey: req.passThroughKey
        });
        if (req.gatewayKey) {
            await db.run("UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?", [req.gatewayKey.id]);
        }
        return res.json(attachOptimizerDebug(gwResponse, binding, optimizerTrace));
    } catch (error) {
        if (tryPassthroughUpstreamError(res, error, binding && binding.error_passthrough)) return;
        console.error("[Gateway POST Images Error]", error.response ? error.response.data : error.message);
        return res.status(500).json({ error: "Upstream request failed", details: error.message });
    }
});

app.post("/v1/videos", authMiddleware, async (req, res) => {
    let binding;
    try {
        binding = await selectModelBinding(req.body.model);
        if (!binding) {
            return res.status(503).json({ error: "Model not found, disabled, or has no available channel" });
        }

        const { gwResponse, upstreamKey, optimizerTrace } = await sendMappedPost(binding, req.body, "Gateway POST videos", {
            upstreamKey: req.passThroughKey
        });
        if (!binding.is_async) {
            return res.json(attachOptimizerDebug(gwResponse, binding, optimizerTrace));
        }

        const upTaskId = gwResponse.task_id;
        if (!upTaskId) {
            return res.status(502).json({ error: "Upstream task ID mapping is missing" });
        }

        const gwTaskId = crypto.randomUUID();
        await db.run(`INSERT INTO async_tasks (
                gw_task_id, up_task_id, gw_key_id, model_id, logical_model_id, binding_id, channel_id,
                upstream_base_url, poll_path_snapshot, poll_mapping_snapshot, upstream_api_key_snapshot,
                proxy_content_snapshot, poll_throttle_snapshot, upstream_auth_type_snapshot,
                original_prompt, optimized_prompt, prompt_optimizer_meta
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            gwTaskId,
            upTaskId,
            req.gatewayKey ? req.gatewayKey.id : null,
            binding.logical_model_id,
            binding.binding_id,
            binding.channel_id,
            binding.base_url,
            binding.poll_path,
            binding.poll_mapping,
            upstreamKey,
            binding.proxy_content ? 1 : 0,
            binding.poll_throttle ? 1 : 0,
            binding.channel_auth_type || "bearer",
            optimizerTrace && optimizerTrace.original_prompt ? optimizerTrace.original_prompt : null,
            optimizerTrace && optimizerTrace.optimized_prompt ? optimizerTrace.optimized_prompt : null,
            optimizerTrace && optimizerTrace.enabled ? JSON.stringify(toMeta(optimizerTrace)) : null
        ]);
        if (req.gatewayKey) {
            await db.run("UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?", [req.gatewayKey.id]);
        }

        return res.json(attachOptimizerDebug({
            id: gwTaskId,
            task_id: gwTaskId,
            model: binding.model_name,
            status: "queued",
            progress: 0,
            created_at: Math.floor(Date.now() / 1000)
        }, binding, optimizerTrace));
    } catch (error) {
        if (tryPassthroughUpstreamError(res, error, binding && binding.error_passthrough)) return;
        console.error("[Gateway POST videos Error]", error.response ? error.response.data : error.message);
        return res.status(500).json({ error: "Upstream request failed" });
    }
});

app.get("/v1/videos/:task_id", authMiddleware, async (req, res) => {
    let taskRecord;
    let pollThrottle = false;
    try {
        taskRecord = await db.get("SELECT * FROM async_tasks WHERE gw_task_id = ?", [req.params.task_id]);
        if (!taskRecord) {
            return res.status(404).json({ error: "Task not found" });
        }

        pollThrottle = await isPollThrottleEnabled(taskRecord);
        if (pollThrottle && !(await claimPollSlot(taskRecord))) {
            return res.json(buildQueuedPollResponse(taskRecord));
        }

        const pollResult = await pollAsyncTask(taskRecord);
        await updateTaskStatus(taskRecord, pollResult);
        if (await shouldProxyTaskContent(taskRecord)) {
            applyProxyContentUrl(req, taskRecord, pollResult);
        }
        return res.json(pollResult);
    } catch (error) {
        if (pollThrottle && isPollRateLimited(error)) {
            return res.json(buildQueuedPollResponse(taskRecord));
        }
        if (tryPassthroughUpstreamError(res, error, await getTaskErrorPassthrough(taskRecord))) return;
        console.error("[Gateway GET Error]", error.message);
        return res.status(500).json({ error: "Failed to poll upstream status" });
    }
});

// Content links are public so browsers and video players can fetch them directly.
app.get("/v1/videos/:task_id/content", async (req, res) => {
    let taskRecord;
    let pollThrottle = false;
    try {
        taskRecord = await db.get("SELECT * FROM async_tasks WHERE gw_task_id = ?", [req.params.task_id]);
        if (!taskRecord) {
            return res.status(404).json({ error: "Task not found" });
        }

        pollThrottle = await isPollThrottleEnabled(taskRecord);
        if (pollThrottle && !(await claimPollSlot(taskRecord))) {
            return res.json({ url: "" });
        }

        const pollResult = await pollAsyncTask(taskRecord);
        await updateTaskStatus(taskRecord, pollResult);
        const videoUrl = pollResult.status === "completed" ? (pollResult.video_url || "") : "";

        // Browsers cannot decode the HEVC that some upstreams return, so /content?format=h264
        // serves an on-demand, cached H.264 rendition. This works for every binding: a task
        // whose result is a public direct link still has to come through the gateway once to
        // be transcoded, so handing that client its own URL back (with ?format=h264) would
        // just loop. Always transcode and serve the file here.
        if (videoUrl && wantsH264(req)) {
            const filePath = await ensureH264Rendition(buildVideoContentFetcher(taskRecord, videoUrl), taskRecord.gw_task_id);
            if (req.query.download === "1") {
                return res.download(filePath, `${taskRecord.gw_task_id}.mp4`);
            }
            return sendLocalVideoFile(req, res, filePath);
        }

        if (pollResult.status === "completed" && await shouldProxyTaskContent(taskRecord)) {
            return proxyVideoContent(req, res, taskRecord, videoUrl);
        }
        return res.json({ url: videoUrl });
    } catch (error) {
        if (pollThrottle && isPollRateLimited(error)) {
            return res.json({ url: "" });
        }
        if (isTranscodeError(error)) {
            console.error("[Gateway H264 Error]", error.message);
            return res.status(502).json({
                error: "H.264 transcoding failed",
                details: error.message
            });
        }
        if (tryPassthroughUpstreamError(res, error, await getTaskErrorPassthrough(taskRecord))) return;
        console.error("[Gateway GET Content Error]", error.message);
        return res.status(500).json({ error: "Failed to poll upstream status" });
    }
});

// Content links are public so browsers and video players can fetch them directly.
// Reports whether a task result is playable by browsers and hands back the H.264 URL,
// so a client can decide up front instead of stalling on an undecodable codec.
app.get("/v1/videos/:task_id/playback", async (req, res) => {
    try {
        const taskRecord = await db.get("SELECT * FROM async_tasks WHERE gw_task_id = ?", [req.params.task_id]);
        if (!taskRecord) {
            return res.status(404).json({ error: "Task not found" });
        }
        const taskId = taskRecord.gw_task_id;
        const base = getGatewayContentUrl(req, taskId);
        const browserUrl = `${base}?format=h264`;
        const renditionSize = await fileSizeIfPresent(h264CachePaths(taskId).result);
        if (renditionSize > 0) {
            return res.json({
                task_id: taskId,
                playable_in_browser: true,
                needs_transcode: false,
                rendition_ready: true,
                rendition_bytes: renditionSize,
                source_codec: "h264",
                browser_url: browserUrl,
                h264_url: browserUrl,
                source_url: base
            });
        }
        const sourceCodec = await probeVideoCodec(cachedSourcePath(taskId));
        const playable = sourceCodec === null ? null : isBrowserPlayableCodec(sourceCodec);
        return res.json({
            task_id: taskId,
            playable_in_browser: playable,
            needs_transcode: playable === null ? null : !playable,
            rendition_ready: false,
            source_codec: sourceCodec,
            browser_url: browserUrl,
            h264_url: browserUrl,
            source_url: base
        });
    } catch (error) {
        console.error("[Gateway Playback Info Error]", error.message);
        return res.status(500).json({ error: "Failed to inspect task content" });
    }
});

const port = Number(process.env.PORT || 3000);

async function start() {
    await db.waitForConnection();
    await db.migrate();
    await ensureSettingsTable(db);
    app.listen(port, () => {
        console.log(`AI Gateway MVP running on http://0.0.0.0:${port}`);
    });
}

if (require.main === module) start().catch(error => {
    console.error("Failed to start gateway:", error.message);
    process.exit(1);
});


module.exports = {
    app,
    start,
    // Exposed for tests: pure helpers for the on-demand H.264 rendition support, for
    // parsing image-bed upload responses, and for the opt-in SSE passthrough path.
    __internal: {
        wantsH264,
        h264CachePaths,
        isBrowserPlayableCodec,
        isTranscodeError,
        H264_FORMATS,
        extractImageBedUrl,
        normalizeVideoError,
        wantsStreamedResponse,
        isStreamPassthroughPayload
    }
};
