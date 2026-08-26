const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const jsonata = require("jsonata");
const morgan = require("morgan");
const path = require("path");
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
    const apiKey = authHeader.split(" ")[1];
    
    try {
        const keyRecord = await db.get("SELECT * FROM gateway_keys WHERE api_key = ? AND status = 1", [apiKey]);
        if (!keyRecord) {
            return res.status(401).json({ error: "Invalid or disabled API Key" });
        }
        if (keyRecord.quota <= keyRecord.used_quota) {
            return res.status(402).json({ error: "Insufficient quota" });
        }
        req.gatewayKey = keyRecord;
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
    const headers = { "Authorization": `Bearer ${upstreamKey}` };
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

app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    const { model } = req.body;
    try {
        const modelRecord = await db.get('SELECT m.*, c.base_url, c.api_key as channel_api_key FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.model_name = ? AND m.status = 1', [model]);
        if (!modelRecord) {
            return res.status(404).json({ error: 'Model not found or disabled' });
        }

        const upstreamPayload = await executeMapping(modelRecord.req_mapping, req.body);
        const upstreamKey = modelRecord.api_key || modelRecord.channel_api_key;
        const upstreamUrl = resolveUpstreamUrl(modelRecord, upstreamPayload);
        
        console.log('[Gateway POST completions] Routing to: ' + upstreamUrl);
        
        await db.run('UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?', [req.gatewayKey.id]);

        const postRequest = await buildPostOptions(upstreamKey, upstreamPayload);
        const upstreamRes = await axios.post(upstreamUrl, postRequest.data, postRequest.options);

        const gwResponse = await executeMapping(modelRecord.resp_mapping, upstreamRes.data);
        res.json(gwResponse);
    } catch (e) {
        console.error('Upstream error:', e.response ? e.response.data : e.message);
        res.status(500).json({ error: 'Upstream request failed', details: e.message });
    }
});

app.post(["/v1/images/generations", "/v1/images/edits"], authMiddleware, async (req, res) => {
    const { model } = req.body;
    try {
        const modelRecord = await db.get("SELECT m.*, c.base_url, c.api_key as channel_api_key FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.model_name = ? AND m.status = 1", [model]);
        if (!modelRecord) {
            return res.status(404).json({ error: "Model not found or disabled" });
        }

        const upstreamPayload = await executeMapping(modelRecord.req_mapping, req.body);
        const upstreamKey = modelRecord.api_key || modelRecord.channel_api_key;
        const upstreamUrl = resolveUpstreamUrl(modelRecord, upstreamPayload);

        console.log(`[Gateway POST images] Routing to: ${upstreamUrl}`);
        const postRequest = await buildPostOptions(upstreamKey, upstreamPayload);
        const upstreamRes = await axios.post(upstreamUrl, postRequest.data, postRequest.options);

        await db.run("UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?", [req.gatewayKey.id]);

        const gwResponse = await executeMapping(modelRecord.resp_mapping, upstreamRes.data);
        return res.json(gwResponse);
    } catch (error) {
        console.error("[Gateway POST Images Error]", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Upstream request failed", details: error.message });
    }
});
app.post("/v1/videos", authMiddleware, async (req, res) => {
    const { model } = req.body;
    try {
        const modelRecord = await db.get("SELECT m.*, c.base_url, c.api_key as channel_api_key FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.model_name = ? AND m.status = 1", [model]);
        if (!modelRecord) {
            return res.status(404).json({ error: "Model not found or disabled" });
        }

        const upstreamPayload = await executeMapping(modelRecord.req_mapping, req.body);
        const upstreamKey = modelRecord.api_key || modelRecord.channel_api_key;
        const upstreamUrl = resolveUpstreamUrl(modelRecord, upstreamPayload);
        
        console.log(`[Gateway POST] Routing to: ${upstreamUrl}`);
        const postRequest = await buildPostOptions(upstreamKey, upstreamPayload);
        const upstreamRes = await axios.post(upstreamUrl, postRequest.data, postRequest.options);

        const gwResponse = await executeMapping(modelRecord.resp_mapping, upstreamRes.data);
        
        if (modelRecord.is_async) {
            const upTaskId = gwResponse.task_id;
            if (!upTaskId) {
                return res.status(502).json({ error: "Upstream task ID mapping is missing" });
            }
            const gwTaskId = upTaskId;

            await db.run("INSERT INTO async_tasks (gw_task_id, up_task_id, gw_key_id, model_id) VALUES (?, ?, ?, ?)",
                [gwTaskId, upTaskId, req.gatewayKey.id, modelRecord.id]);
            
            await db.run("UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?", [req.gatewayKey.id]);
            
            return res.json({
                id: gwTaskId,
                task_id: gwTaskId,
                model: modelRecord.model_name,
                status: "queued",
                progress: 0,
                created_at: Math.floor(Date.now() / 1000)
            });
        } else {
            return res.json(gwResponse);
        }
    } catch (error) {
        console.error("[Gateway POST Error]", error.message);
        res.status(500).json({ error: "Upstream request failed" });
    }
});

app.get("/v1/videos/:task_id", authMiddleware, async (req, res) => {
    const { task_id } = req.params;
    try {
        const taskRecord = await db.get("SELECT * FROM async_tasks WHERE gw_task_id = ?", [task_id]);
        if (!taskRecord) {
            return res.status(404).json({ error: "Task not found" });
        }
        const modelRecord = await db.get("SELECT m.*, c.base_url, c.api_key as channel_api_key FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?", [taskRecord.model_id]);

        let upPollPath = modelRecord.poll_path || "/";
        upPollPath = upPollPath.replace("${up_task_id}", taskRecord.up_task_id);

        const upstreamUrl = modelRecord.base_url + upPollPath;
        const upstreamKey = modelRecord.api_key || modelRecord.channel_api_key;

        const upstreamRes = await axios.get(upstreamUrl, {
            headers: { "Authorization": `Bearer ${upstreamKey}` }
        });

        const pollResult = await executeMapping(modelRecord.poll_mapping, upstreamRes.data);

        pollResult.id = taskRecord.gw_task_id;
        pollResult.task_id = taskRecord.gw_task_id;

        if (pollResult.status === "completed") {
            await db.run("UPDATE async_tasks SET status = 'completed' WHERE gw_task_id = ?", [task_id]);
        }
        else if (pollResult.status === "failed") {
            await db.run("UPDATE async_tasks SET status = 'failed' WHERE gw_task_id = ?", [task_id]);
            await db.run("UPDATE gateway_keys SET used_quota = used_quota - 1 WHERE id = ?", [taskRecord.gw_key_id]);
        }

        return res.json(pollResult);
    } catch (error) {
        console.error("[Gateway GET Error]", error.message);
        res.status(500).json({ error: "Failed to poll upstream status" });
    }
});

app.get("/v1/videos/:task_id/content", authMiddleware, async (req, res) => {
    const { task_id } = req.params;
    try {
        const taskRecord = await db.get("SELECT * FROM async_tasks WHERE gw_task_id = ?", [task_id]);
        if (!taskRecord) {
            return res.status(404).json({ error: "Task not found" });
        }
        const modelRecord = await db.get("SELECT m.*, c.base_url, c.api_key as channel_api_key FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?", [taskRecord.model_id]);

        let upPollPath = modelRecord.poll_path || "/";
        upPollPath = upPollPath.replace("${up_task_id}", taskRecord.up_task_id);

        const upstreamUrl = modelRecord.base_url + upPollPath;
        const upstreamKey = modelRecord.api_key || modelRecord.channel_api_key;

        const upstreamRes = await axios.get(upstreamUrl, {
            headers: { "Authorization": `Bearer ${upstreamKey}` }
        });

        const pollResult = await executeMapping(modelRecord.poll_mapping, upstreamRes.data);
        const videoUrl = pollResult && pollResult.status === "completed" ? (pollResult.video_url || "") : "";

        if (pollResult.status === "completed") {
            await db.run("UPDATE async_tasks SET status = 'completed' WHERE gw_task_id = ?", [task_id]);
        } else if (pollResult.status === "failed") {
            await db.run("UPDATE async_tasks SET status = 'failed' WHERE gw_task_id = ?", [task_id]);
            await db.run("UPDATE gateway_keys SET used_quota = used_quota - 1 WHERE id = ?", [taskRecord.gw_key_id]);
        }

        return res.status(200).type("application/json").json({ url: videoUrl });
    } catch (error) {
        console.error("[Gateway GET Content Error]", error.message);
        res.status(500).json({ error: "Failed to poll upstream status" });
    }
});

const port = Number(process.env.PORT || 3000);

async function start() {
    await db.waitForConnection();
    app.listen(port, () => {
        console.log(`AI Gateway MVP running on http://0.0.0.0:${port}`);
    });
}

start().catch(error => {
    console.error("Failed to start gateway:", error.message);
    process.exit(1);
});

