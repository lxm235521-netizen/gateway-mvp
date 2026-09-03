const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const jsonata = require("jsonata");
const morgan = require("morgan");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");

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
    "file_fields"
]);

const adminRouter = require("./admin-api")(db);
app.use("/admin", adminRouter);

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
            if (keyRecord.quota <= keyRecord.used_quota) {
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

async function buildPostOptions(upstreamKey, upstreamPayload) {
    const headers = upstreamKey ? { "Authorization": `Bearer ${upstreamKey}` } : {};
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
            c.base_url,
            c.api_key AS channel_api_key,
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

async function sendMappedPost(binding, body, logLabel, options = {}) {
    const upstreamPayload = await executeMapping(binding.req_mapping, body);
    const upstreamKey = options.upstreamKey || binding.api_key || binding.channel_api_key;
    const upstreamUrl = resolveUpstreamUrl(binding, upstreamPayload);

    console.log(`[${logLabel}] Routing ${binding.model_name} to ${binding.channel_name}: ${upstreamUrl}`);
    const postRequest = await buildPostOptions(upstreamKey, upstreamPayload);
    const upstreamRes = await axios.post(upstreamUrl, postRequest.data, postRequest.options);
    const gwResponse = await executeMapping(binding.resp_mapping, upstreamRes.data);

    return { gwResponse, upstreamKey };
}

async function loadLegacyPollRuntime(taskRecord) {
    const modelRecord = await db.get("SELECT m.*, c.base_url, c.api_key as channel_api_key FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?", [taskRecord.model_id]);
    if (!modelRecord) {
        return null;
    }
    return {
        base_url: modelRecord.base_url,
        poll_path: modelRecord.poll_path,
        poll_mapping: modelRecord.poll_mapping,
        upstream_key: modelRecord.api_key || modelRecord.channel_api_key
    };
}

async function pollAsyncTask(taskRecord) {
    const runtime = (taskRecord.binding_id || taskRecord.upstream_base_url || taskRecord.poll_path_snapshot || taskRecord.poll_mapping_snapshot || taskRecord.upstream_api_key_snapshot)
        ? {
            base_url: taskRecord.upstream_base_url,
            poll_path: taskRecord.poll_path_snapshot,
            poll_mapping: taskRecord.poll_mapping_snapshot,
            upstream_key: taskRecord.upstream_api_key_snapshot
        }
        : await loadLegacyPollRuntime(taskRecord);

    if (!runtime) {
        throw new Error("Task binding not found");
    }

    let upPollPath = runtime.poll_path || "/";
    upPollPath = upPollPath.replace("${up_task_id}", taskRecord.up_task_id);

    const upstreamRes = await axios.get(runtime.base_url + upPollPath, {
        headers: runtime.upstream_key ? { "Authorization": `Bearer ${runtime.upstream_key}` } : {}
    });

    const pollResult = await executeMapping(runtime.poll_mapping, upstreamRes.data);
    pollResult.id = taskRecord.gw_task_id;
    pollResult.task_id = taskRecord.gw_task_id;
    return pollResult;
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

    const headers = {};
    if (taskRecord.upstream_api_key_snapshot) {
        headers.Authorization = "Bearer " + taskRecord.upstream_api_key_snapshot;
    }
    if (req.headers.range) {
        headers.Range = req.headers.range;
    }
    if (req.headers["if-range"]) {
        headers["If-Range"] = req.headers["if-range"];
    }

    const upstreamRes = await axios.get(videoUrl, {
        headers,
        responseType: "stream",
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: Number(process.env.UPSTREAM_VIDEO_TIMEOUT_MS || 30000),
        validateStatus: () => true
    });

    if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
        upstreamRes.data.resume();
        console.error("[Gateway Video Proxy Upstream Error]", upstreamRes.status);
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

app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    try {
        const binding = await selectModelBinding(req.body.model);
        if (!binding) {
            return res.status(503).json({ error: "Model not found, disabled, or has no available channel" });
        }

        if (req.gatewayKey) {
            await db.run('UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?', [req.gatewayKey.id]);
        }
        const { gwResponse } = await sendMappedPost(binding, req.body, "Gateway POST completions", {
            upstreamKey: req.passThroughKey
        });
        return res.json(gwResponse);
    } catch (error) {
        console.error("[Gateway POST completions Error]", error.response ? error.response.data : error.message);
        return res.status(500).json({ error: "Upstream request failed", details: error.message });
    }
});

app.post(["/v1/images/generations", "/v1/images/edits"], authMiddleware, async (req, res) => {
    try {
        const binding = await selectModelBinding(req.body.model);
        if (!binding) {
            return res.status(503).json({ error: "Model not found, disabled, or has no available channel" });
        }

        const { gwResponse } = await sendMappedPost(binding, req.body, "Gateway POST images", {
            upstreamKey: req.passThroughKey
        });
        if (req.gatewayKey) {
            await db.run("UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?", [req.gatewayKey.id]);
        }
        return res.json(gwResponse);
    } catch (error) {
        console.error("[Gateway POST Images Error]", error.response ? error.response.data : error.message);
        return res.status(500).json({ error: "Upstream request failed", details: error.message });
    }
});

app.post("/v1/videos", authMiddleware, async (req, res) => {
    try {
        const binding = await selectModelBinding(req.body.model);
        if (!binding) {
            return res.status(503).json({ error: "Model not found, disabled, or has no available channel" });
        }

        const { gwResponse, upstreamKey } = await sendMappedPost(binding, req.body, "Gateway POST videos", {
            upstreamKey: req.passThroughKey
        });
        if (!binding.is_async) {
            return res.json(gwResponse);
        }

        const upTaskId = gwResponse.task_id;
        if (!upTaskId) {
            return res.status(502).json({ error: "Upstream task ID mapping is missing" });
        }

        const gwTaskId = crypto.randomUUID();
        await db.run(`INSERT INTO async_tasks (
                gw_task_id, up_task_id, gw_key_id, model_id, logical_model_id, binding_id, channel_id,
                upstream_base_url, poll_path_snapshot, poll_mapping_snapshot, upstream_api_key_snapshot,
                proxy_content_snapshot
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
            binding.proxy_content ? 1 : 0
        ]);
        if (req.gatewayKey) {
            await db.run("UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?", [req.gatewayKey.id]);
        }

        return res.json({
            id: gwTaskId,
            task_id: gwTaskId,
            model: binding.model_name,
            status: "queued",
            progress: 0,
            created_at: Math.floor(Date.now() / 1000)
        });
    } catch (error) {
        console.error("[Gateway POST videos Error]", error.response ? error.response.data : error.message);
        return res.status(500).json({ error: "Upstream request failed" });
    }
});

app.get("/v1/videos/:task_id", authMiddleware, async (req, res) => {
    try {
        const taskRecord = await db.get("SELECT * FROM async_tasks WHERE gw_task_id = ?", [req.params.task_id]);
        if (!taskRecord) {
            return res.status(404).json({ error: "Task not found" });
        }

        const pollResult = await pollAsyncTask(taskRecord);
        await updateTaskStatus(taskRecord, pollResult);
        if (await shouldProxyTaskContent(taskRecord)) {
            applyProxyContentUrl(req, taskRecord, pollResult);
        }
        return res.json(pollResult);
    } catch (error) {
        console.error("[Gateway GET Error]", error.message);
        return res.status(500).json({ error: "Failed to poll upstream status" });
    }
});

app.get("/v1/videos/:task_id/content", authMiddleware, async (req, res) => {
    try {
        const taskRecord = await db.get("SELECT * FROM async_tasks WHERE gw_task_id = ?", [req.params.task_id]);
        if (!taskRecord) {
            return res.status(404).json({ error: "Task not found" });
        }

        const pollResult = await pollAsyncTask(taskRecord);
        await updateTaskStatus(taskRecord, pollResult);
        const videoUrl = pollResult.status === "completed" ? (pollResult.video_url || "") : "";
        if (pollResult.status === "completed" && await shouldProxyTaskContent(taskRecord)) {
            return proxyVideoContent(req, res, taskRecord, videoUrl);
        }
        return res.json({ url: videoUrl });
    } catch (error) {
        console.error("[Gateway GET Content Error]", error.message);
        return res.status(500).json({ error: "Failed to poll upstream status" });
    }
});

const port = Number(process.env.PORT || 3000);

async function start() {
    await db.waitForConnection();
    await db.migrate();
    app.listen(port, () => {
        console.log(`AI Gateway MVP running on http://0.0.0.0:${port}`);
    });
}

start().catch(error => {
    console.error("Failed to start gateway:", error.message);
    process.exit(1);
});

