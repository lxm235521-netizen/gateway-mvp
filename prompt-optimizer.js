"use strict";

/**
 * Pure payload-transform layer for the optional prompt-optimization step.
 *
 * The gateway may forward a user's prompt text (plus any input images/videos/audios)
 * to an external OpenAI-compatible "prompt optimizer" and then write the optimized
 * text back into the original request body. This module only extracts and re-inserts
 * values: it performs no network, database or async work.
 */

// Top-level scalar fields that may carry the prompt, in priority order.
const PROMPT_FIELDS = ["prompt", "text", "query", "message", "input", "description"];

// Object keys (matched case-insensitively on the last path segment) whose values
// describe media assets.
const MEDIA_KEYS = new Set([
    "images",
    "image",
    "image_url",
    "image_urls",
    "init_image",
    "first_frame",
    "first_frame_image",
    "last_frame",
    "last_frame_image",
    "tail_frame",
    "reference_images",
    "ref_images",
    "input_images",
    "videos",
    "video",
    "video_url",
    "video_urls",
    "audios",
    "audio",
    "audio_url"
]);

// Keys under which a raw base64 blob (rather than a URL) is expected.
const BASE64_KEYS = new Set(["image", "image_base64", "b64_json", "base64", "data"]);

// Keys that hold the actual asset reference inside a media descriptor object.
const ASSET_VALUE_KEYS = new Set([
    "url",
    "uri",
    "data",
    "base64",
    "b64_json",
    "source",
    "image",
    "image_url",
    "video_url",
    "audio_url",
    "image_base64"
]);

const KIND_LABELS = { image: "图片", video: "视频", audio: "音频" };
const KIND_UNITS = { image: "张", video: "个", audio: "个" };
const KIND_SIZE_PHRASES = { image: "单张图片", video: "单个视频", audio: "单个音频" };

const DEFAULT_LIMITS = { maxImages: 9, maxVideos: 3, maxAudios: 3, maxDataUrlBytes: 8 * 1024 * 1024 };

const INLINE_MODES = ["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"];

// `mode:Ref2VA`, `模式=FL2VA`, `--mode I2VA` (also full-width colon, any casing).
const INLINE_MODE_RE = /(?:--\s*mode\s*[:=\s：]\s*|模式\s*[:=\s：]\s*|mode\s*[:=\s：]\s*)([A-Za-z0-9]+)/i;

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathToString(parts) {
    let out = "";
    for (const part of parts) {
        if (typeof part === "number") {
            out += "[" + part + "]";
        } else {
            out += out ? "." + part : String(part);
        }
    }
    return out;
}

// Last non-index segment of a path, lowercased (used for the base64-key heuristic).
function lastStringSegment(parts) {
    for (let i = parts.length - 1; i >= 0; i--) {
        if (typeof parts[i] === "string") {
            return parts[i].toLowerCase();
        }
    }
    return "";
}

function kindForMediaKey(key) {
    const lower = String(key).toLowerCase();
    if (!MEDIA_KEYS.has(lower)) {
        return null;
    }
    if (lower.includes("video")) {
        return "video";
    }
    if (lower.includes("audio")) {
        return "audio";
    }
    if (lower.includes("image") || lower.includes("frame") || lower.includes("ref")) {
        return "image";
    }
    return null;
}

// A string qualifies as an asset reference only when it is a data URL, an http(s)
// URL, or a long base64 blob sitting under a base64-ish key.
function isUsableAssetReference(value, keyHint) {
    if (typeof value !== "string") {
        return false;
    }
    const text = value.trim();
    if (!text) {
        return false;
    }
    if (/^data:/i.test(text) || /^https?:\/\//i.test(text)) {
        return true;
    }
    if (text.length > 64 && BASE64_KEYS.has(String(keyHint || "").toLowerCase())) {
        return /^[A-Za-z0-9+/=\s]+$/.test(text);
    }
    return false;
}

function pushMedia(media, pathParts, kind, url) {
    media.push({ path: pathToString(pathParts), kind, url });
}

// Walk the value of a media-ish key and pull out every usable reference in order.
function collectAssetValue(node, pathParts, media, kind) {
    if (node === null || node === undefined || !kind) {
        return;
    }
    if (typeof node === "string") {
        if (isUsableAssetReference(node, lastStringSegment(pathParts))) {
            pushMedia(media, pathParts, kind, node);
        }
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((child, index) => collectAssetValue(child, pathParts.concat(index), media, kind));
        return;
    }
    if (typeof node !== "object") {
        return;
    }
    for (const key of Object.keys(node)) {
        const lower = key.toLowerCase();
        const child = node[key];
        const childPath = pathParts.concat(key);
        if (ASSET_VALUE_KEYS.has(lower)) {
            collectAssetValue(child, childPath, media, kind);
        } else if (MEDIA_KEYS.has(lower)) {
            // e.g. { type: "image_url", image_url: { url } }
            collectAssetValue(child, childPath, media, kindForMediaKey(lower));
        }
    }
}

// Generic depth-first scan of the whole payload for media-ish keys.
function scanForMedia(node, pathParts, media) {
    if (node === null || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((child, index) => scanForMedia(child, pathParts.concat(index), media));
        return;
    }
    for (const key of Object.keys(node)) {
        const lower = key.toLowerCase();
        const child = node[key];
        const childPath = pathParts.concat(key);
        if (MEDIA_KEYS.has(lower)) {
            collectAssetValue(child, childPath, media, kindForMediaKey(lower));
        } else {
            scanForMedia(child, childPath, media);
        }
    }
}

// Locate the prompt text and the path needed to write it back.
function findTextTarget(payload) {
    if (!isObject(payload)) {
        return null;
    }
    const messages = payload.messages;
    if (Array.isArray(messages)) {
        // Chat requests win over top-level fields: use the LAST user message only.
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (!isObject(message) || String(message.role).toLowerCase() !== "user") {
                continue;
            }
            const content = message.content;
            if (typeof content === "string") {
                if (content.trim()) {
                    return { text: content, textPath: ["messages", i, "content"] };
                }
            } else if (Array.isArray(content)) {
                for (let j = 0; j < content.length; j++) {
                    const part = content[j];
                    if (isObject(part) && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                        return { text: part.text, textPath: ["messages", i, "content", j, "text"] };
                    }
                }
            }
            break;
        }
    }
    for (const field of PROMPT_FIELDS) {
        const value = payload[field];
        if (typeof value === "string" && value.trim()) {
            return { text: value, textPath: [field] };
        }
    }
    return null;
}

function deepClone(value) {
    if (Array.isArray(value)) {
        return value.map(deepClone);
    }
    if (value !== null && typeof value === "object") {
        if (Buffer.isBuffer(value)) {
            return Buffer.from(value);
        }
        if (value instanceof Date) {
            return new Date(value.getTime());
        }
        const clone = {};
        for (const key of Object.keys(value)) {
            clone[key] = deepClone(value[key]);
        }
        return clone;
    }
    return value;
}

function stripHtmlComments(text) {
    return String(text).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

// Normalize whatever the optimizer returned into the prompt body alone: drop
// metadata comments, unwrap a markdown fence, and drop a leading label line.
function normalizePromptText(text) {
    const withoutComments = stripHtmlComments(text).trim();
    if (!withoutComments) {
        return "";
    }
    const fenced = extractFencedBody(withoutComments);
    if (fenced) {
        return stripHtmlComments(fenced).trim();
    }
    return stripLeadingLabel(withoutComments);
}

function setAtPath(root, path, value) {
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
        node = node[path[i]];
        if (node === null || typeof node !== "object") {
            return false;
        }
    }
    const last = path[path.length - 1];
    if (node === null || typeof node !== "object") {
        return false;
    }
    node[last] = value;
    return true;
}

function stripCodeFence(text) {
    let out = String(text).trim();
    const open = out.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/);
    if (!open) {
        return out;
    }
    out = out.slice(open[0].length);
    const close = out.lastIndexOf("```");
    if (close !== -1) {
        out = out.slice(0, close);
    }
    return out.trim();
}

// The optimizer sometimes wraps the prompt in a markdown fence, optionally behind
// a heading such as "## H3 提示词（T2VA）". Only the fenced body is the prompt.
function extractFencedBody(text) {
    const source = String(text);
    const blocks = [...source.matchAll(/```[^\n]*\r?\n([\s\S]*?)```/g)].map(match => match[1].trim()).filter(Boolean);
    if (blocks.length === 0) {
        return null;
    }
    // A real prompt is far longer than an inline example, so the longest block wins.
    return blocks.reduce((longest, block) => (block.length > longest.length ? block : longest), "");
}

// Remove a leading markdown/Chinese label line, e.g. "## H3 提示词（T2VA）".
function stripLeadingLabel(text) {
    const lines = String(text).trim().split("\n");
    while (lines.length > 1) {
        const first = lines[0].trim();
        const looksLikeLabel = !first || /^#{1,6}\s/.test(first) || /^[^:：]{0,24}[:：]\s*$/.test(first);
        if (!looksLikeLabel) {
            break;
        }
        lines.shift();
    }
    return lines.join("\n").trim();
}

function extractPrompt(payload) {
    const result = { prompt: null, text: null, textPath: null, media: [] };
    if (!isObject(payload)) {
        return result;
    }
    const target = findTextTarget(payload);
    if (target) {
        result.prompt = target.text;
        result.text = target.text;
        result.textPath = target.textPath;
    }
    scanForMedia(payload, [], result.media);
    return result;
}

function applyOptimizedPrompt(payload, optimizedText) {
    const clone = deepClone(payload);
    if (typeof optimizedText !== "string") {
        return clone;
    }
    const cleaned = stripHtmlComments(optimizedText).trim();
    if (!cleaned) {
        return clone;
    }
    const target = findTextTarget(clone);
    if (!target) {
        return clone;
    }
    // setAtPath mutates the clone in place, so surrounding part objects survive.
    setAtPath(clone, target.textPath, cleaned);
    return clone;
}

function parseOptimizerResponse(responseData) {
    if (!isObject(responseData)) {
        return null;
    }
    const choices = responseData.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        return null;
    }
    const first = choices[0];
    if (!isObject(first) || !isObject(first.message) || typeof first.message.content !== "string") {
        return null;
    }

    const content = stripCodeFence(first.message.content);
    if (!content) {
        return null;
    }

    let parsed = null;
    let isJson = true;
    try {
        parsed = JSON.parse(content);
    } catch {
        isJson = false;
    }

    if (isJson && isObject(parsed)) {
        for (const field of ["prompt", "optimized_prompt", "rewritten_prompt", "text"]) {
            const value = parsed[field];
            if (typeof value === "string" && value.trim()) {
                const cleaned = normalizePromptText(value);
                if (cleaned) {
                    return cleaned;
                }
            }
        }
        return null;
    }

    const plain = normalizePromptText(content);
    return plain ? plain : null;
}

function buildContentParts(prompt, media, kind) {
    const parts = [];
    if (prompt) {
        parts.push({ type: "text", text: prompt });
    }
    const seen = new Set();
    const list = Array.isArray(media) ? media : [];
    for (const item of list) {
        if (!isObject(item) || item.kind !== kind) {
            continue;
        }
        const url = item.url;
        if (typeof url !== "string" || !url || seen.has(url)) {
            continue;
        }
        seen.add(url);
        if (kind === "image") {
            parts.push({ type: "image_url", image_url: { url } });
        } else if (kind === "video") {
            parts.push({ type: "video_url", video_url: { url } });
        } else if (kind === "audio") {
            parts.push({ type: "input_audio", input_audio: { data: url } });
        }
    }
    return parts;
}

function isValidAssetUrl(value) {
    return /^data:/i.test(value) || /^https?:\/\//i.test(value);
}

// Decoded payload size of a data URL. For base64 we estimate from the encoded
// length instead of decoding, which is accurate to within the padding bytes.
function dataUrlPayloadBytes(url) {
    const comma = String(url).indexOf(",");
    if (comma === -1) {
        return 0;
    }
    const meta = url.slice(5, comma);
    const data = url.slice(comma + 1);
    if (/;base64/i.test(meta)) {
        const encoded = data.replace(/\s/g, "");
        const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
        return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
    }
    return Buffer.byteLength(data, "utf8");
}

function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) {
        const rounded = Math.round(mb * 10) / 10;
        return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}MB`;
    }
    return `${Math.round(bytes)}B`;
}

function failValidation(result, reason) {
    result.ok = false;
    result.reason = reason;
    return result;
}

function validateMedia(media, limits) {
    const opts = Object.assign({}, DEFAULT_LIMITS, isObject(limits) ? limits : {});
    const result = { ok: true, reason: null, images: [], videos: [], audios: [] };

    const list = Array.isArray(media) ? media : [];
    for (const item of list) {
        if (!isObject(item)) {
            continue;
        }
        const normalized = { path: item.path, kind: item.kind, url: item.url };
        if (normalized.kind === "image") {
            result.images.push(normalized);
        } else if (normalized.kind === "video") {
            result.videos.push(normalized);
        } else if (normalized.kind === "audio") {
            result.audios.push(normalized);
        }
    }

    const groups = [
        { kind: "image", items: result.images, max: opts.maxImages },
        { kind: "video", items: result.videos, max: opts.maxVideos },
        { kind: "audio", items: result.audios, max: opts.maxAudios }
    ];

    for (const group of groups) {
        if (group.items.length > group.max) {
            const label = KIND_LABELS[group.kind];
            return failValidation(result, `${label}数量超过上限 ${group.max} ${KIND_UNITS[group.kind]}`);
        }
    }

    for (const group of groups) {
        for (const item of group.items) {
            const url = typeof item.url === "string" ? item.url.trim() : "";
            if (/^data:/i.test(url) && dataUrlPayloadBytes(url) > opts.maxDataUrlBytes) {
                return failValidation(
                    result,
                    `${KIND_SIZE_PHRASES[group.kind]}超过 ${formatBytes(opts.maxDataUrlBytes)} 限制`
                );
            }
            if (!isValidAssetUrl(url)) {
                return failValidation(result, `${KIND_LABELS[group.kind]}地址不是合法的 http(s) 或 data URL`);
            }
        }
    }

    return result;
}

function parseInlineMode(text) {
    if (typeof text !== "string") {
        return { mode: null, text: "" };
    }
    let mode = null;
    let out = text;
    const match = INLINE_MODE_RE.exec(text);
    if (match) {
        const canonical = INLINE_MODES.find((item) => item.toLowerCase() === match[1].toLowerCase());
        // Unknown tokens (e.g. "mode:XYZ") are left in place rather than eaten.
        if (canonical) {
            mode = canonical;
            out = text.slice(0, match.index) + " " + text.slice(match.index + match[0].length);
        }
    }
    return { mode, text: out.replace(/\s+/g, " ").trim() };
}

module.exports = {
    extractPrompt,
    applyOptimizedPrompt,
    parseOptimizerResponse,
    buildContentParts,
    validateMedia,
    parseInlineMode
};
