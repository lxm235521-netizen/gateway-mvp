const express = require("express");
const crypto = require("crypto");
const { normalizeAuthType } = require("./upstream-auth");
const { formatOptimizerError, optimizeWithConfig, resolveOptimizerConfig, GLOBAL_OPTIMIZER_FIELDS } = require("./prompt-optimizer-service");
const {
    readOptimizerDefaults: readSettingDefaults,
    writeOptimizerDefaults: persistOptimizerDefaults
} = require("./gateway-settings");
const router = express.Router();

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin-password";
const ADMIN_TOKEN = crypto.createHash("sha256").update(ADMIN_PASS).digest("hex");

// Sample body used by the admin "test optimization" action. Text only, so the
// check costs one short optimizer call and never touches an upstream channel.
const OPTIMIZER_TEST_PAYLOAD = {
    model: "prompt-optimizer-test",
    prompt: "深夜的旧仓库。老陈推开锈迹斑斑的铁门，手电光柱扫过满地纸箱。他身后跟着十七岁的小满。",
    seconds: "10",
    aspect_ratio: "16:9"
};

router.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        res.json({ success: true, token: ADMIN_TOKEN });
    } else {
        res.status(401).json({ success: false, error: "Invalid credentials" });
    }
});

function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${ADMIN_TOKEN}`) {
        return res.status(401).json({ error: "Unauthorized Admin" });
    }
    next();
}

function normalizeBinding(binding) {
    return {
        channel_id: binding.channel_id,
        route_path: binding.route_path,
        poll_path: binding.poll_path || null,
        api_key: binding.api_key || null,
        is_async: binding.is_async ? 1 : 0,
        proxy_content: binding.proxy_content ? 1 : 0,
        error_passthrough: binding.error_passthrough === undefined ? 1 : (binding.error_passthrough ? 1 : 0),
        poll_throttle: binding.poll_throttle ? 1 : 0,
        req_mapping: binding.req_mapping || "{}",
        resp_mapping: binding.resp_mapping || "{}",
        poll_mapping: binding.poll_mapping || "{}",
        weight: Math.max(Number(binding.weight || 1), 1),
        status: binding.status !== undefined ? (binding.status ? 1 : 0) : 1
    };
}

const DEFAULT_OPTIMIZER_MODEL = "h3-prompt-writing";
const DEFAULT_OPTIMIZER_TIMEOUT_MS = 120000;
// The optimizer throttles per account when a burst lands at once; the gateway
// queues instead. These two are global-only knobs.
const DEFAULT_OPTIMIZER_CONCURRENCY = 8;
const MAX_OPTIMIZER_CONCURRENCY = 500;
const DEFAULT_OPTIMIZER_QUEUE_WAIT_MS = 300000;

function clampInt(value, fallback, min, max) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) {
        return fallback;
    }
    return Math.min(Math.max(Math.trunc(raw), min), max);
}

// Accepts "image,video", "image video" and casing variants.
function normalizeOptimizerMediaKinds(value) {
    const kinds = String(value || "").split(/[,\s|;]+/)
        .map(token => token.trim().toLowerCase())
        .filter(token => ["image", "video", "audio"].includes(token));
    return kinds.length > 0 ? [...new Set(kinds)].join(",") : "image";
}

function normalizeOptimizerConfig(body) {
    const timeout = Number(body.optimizer_timeout_ms);
    return {
        optimize_prompt: body.optimize_prompt ? 1 : 0,
        optimizer_base_url: body.optimizer_base_url ? String(body.optimizer_base_url).trim() : null,
        optimizer_api_key: body.optimizer_api_key ? String(body.optimizer_api_key).trim() : null,
        optimizer_model: body.optimizer_model ? String(body.optimizer_model).trim() : DEFAULT_OPTIMIZER_MODEL,
        optimizer_system_prompt: body.optimizer_system_prompt ? String(body.optimizer_system_prompt) : null,
        optimizer_json_mode: body.optimizer_json_mode === undefined ? 1 : (body.optimizer_json_mode ? 1 : 0),
        optimizer_timeout_ms: Number.isFinite(timeout) && timeout > 0
            ? Math.min(Math.max(Math.trunc(timeout), 1000), 600000)
            : DEFAULT_OPTIMIZER_TIMEOUT_MS,
        optimizer_send_media: normalizeOptimizerMediaKinds(body.optimizer_send_media),
        optimizer_allow_http: body.optimizer_allow_http ? 1 : 0,
        optimizer_debug: body.optimizer_debug ? 1 : 0
    };
}

async function getModel(db, id) {
    const model = await db.get("SELECT * FROM logical_models WHERE id = ?", [id]);
    if (!model) return null;
    model.bindings = await db.all(`SELECT b.*, c.name AS channel_name, c.base_url, c.status AS channel_status
        FROM model_bindings b JOIN channels c ON c.id = b.channel_id
        WHERE b.logical_model_id = ? ORDER BY b.id`, [id]);
    return model;
}

function readOptimizerDefaults(db) {
    return readSettingDefaults(db);
}

async function writeOptimizerDefaults(db, body) {
    const normalized = normalizeOptimizerConfig(body);
    // An empty key means "keep the saved one" so the UI never round-trips secrets.
    if (!normalized.optimizer_api_key) {
        const existing = await readSettingDefaults(db);
        normalized.optimizer_api_key = (existing && existing.optimizer_api_key) || null;
    }
    normalized.enabled = body.enabled ? 1 : 0;
    normalized.optimizer_concurrency = clampInt(body.optimizer_concurrency, DEFAULT_OPTIMIZER_CONCURRENCY, 1, MAX_OPTIMIZER_CONCURRENCY);
    normalized.optimizer_queue_wait_ms = clampInt(body.optimizer_queue_wait_ms, DEFAULT_OPTIMIZER_QUEUE_WAIT_MS, 10000, 3600000);
    await persistOptimizerDefaults(db, normalized);
    return normalized;
}

// Saved connection values are used for the admin connectivity check, with any
// value typed into the dialog taking precedence.
function buildOptimizerTestConfig(defaults, body) {
    const global = defaults || {};
    // Same precedence as a real request: explicitly supplied value, then the saved
    // global default, then the built-in default.
    const config = resolveOptimizerConfig({ optimize_prompt: 1 }, global);
    for (const field of GLOBAL_OPTIMIZER_FIELDS) {
        const value = body ? body[field] : undefined;
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            config[field] = value;
        }
    }
    const concurrency = Number(body && body.optimizer_concurrency);
    config.optimizer_concurrency = Number.isFinite(concurrency) && concurrency > 0
        ? Math.trunc(concurrency)
        : (global.optimizer_concurrency || DEFAULT_OPTIMIZER_CONCURRENCY);
    const queueWait = Number(body && body.optimizer_queue_wait_ms);
    config.optimizer_queue_wait_ms = Number.isFinite(queueWait) && queueWait > 0
        ? Math.trunc(queueWait)
        : (global.optimizer_queue_wait_ms || DEFAULT_OPTIMIZER_QUEUE_WAIT_MS);
    config.optimize_prompt = 1;
    config.optimizer_model = config.optimizer_model || DEFAULT_OPTIMIZER_MODEL;
    config.optimizer_timeout_ms = config.optimizer_timeout_ms || DEFAULT_OPTIMIZER_TIMEOUT_MS;
    config.optimizer_send_media = "image";
    if (!config.optimizer_concurrency) {
        config.optimizer_concurrency = DEFAULT_OPTIMIZER_CONCURRENCY;
    }
    return config;
}

module.exports = function(db) {
    router.get("/channels", adminAuth, async (req, res) => {
        try { res.json(await db.all("SELECT * FROM channels ORDER BY id")); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/channels", adminAuth, async (req, res) => {
        const { name, base_url, api_key, status, convert_base64_to_url } = req.body;
        let authType;
        try { authType = normalizeAuthType(req.body.auth_type); }
        catch (e) { return res.status(400).json({ error: e.message }); }
        try {
            await db.run("INSERT INTO channels (name, base_url, api_key, status, auth_type, convert_base64_to_url) VALUES (?, ?, ?, ?, ?, ?)", [name, base_url, api_key || null, status !== undefined ? status : 1, authType, convert_base64_to_url ? 1 : 0]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/channels/:id", adminAuth, async (req, res) => {
        const { name, base_url, api_key, status, convert_base64_to_url } = req.body;
        let authType = null;
        if (req.body.auth_type !== undefined) {
            try { authType = normalizeAuthType(req.body.auth_type); }
            catch (e) { return res.status(400).json({ error: e.message }); }
        }
        try {
            await db.run("UPDATE channels SET name=?, base_url=?, api_key=?, status=?, auth_type=COALESCE(?, auth_type), convert_base64_to_url=COALESCE(?, convert_base64_to_url) WHERE id=?", [name, base_url, api_key || null, status !== undefined ? status : 1, authType, convert_base64_to_url === undefined ? null : (convert_base64_to_url ? 1 : 0), req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete("/channels/:id", adminAuth, async (req, res) => {
        try {
            const channel = await db.get("SELECT id, status FROM channels WHERE id = ?", [req.params.id]);
            if (!channel) return res.status(404).json({ error: "渠道不存在" });
            const bindings = await db.get("SELECT COUNT(*) AS count FROM model_bindings WHERE channel_id = ? AND status = 1", [req.params.id]);
            if (Number(bindings && bindings.count) > 0) {
                return res.status(409).json({ error: "渠道仍有启用中的模型绑定，请先删除或禁用绑定" });
            }
            await db.run("UPDATE channels SET status=0 WHERE id=?", [req.params.id]);
            res.json({ success: true, status: 0 });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get("/models", adminAuth, async (req, res) => {
        try {
            const models = await db.all("SELECT * FROM logical_models ORDER BY id");
            for (const model of models) {
                model.bindings = await db.all(`SELECT b.*, c.name AS channel_name, c.base_url, c.status AS channel_status
                    FROM model_bindings b JOIN channels c ON c.id = b.channel_id
                    WHERE b.logical_model_id = ? ORDER BY b.id`, [model.id]);
            }
            res.json(models);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/models", adminAuth, async (req, res) => {
        const { model_name, status, remark, bindings } = req.body;
        const optimizer = normalizeOptimizerConfig(req.body);
        try {
            const result = await db.run(`INSERT INTO logical_models
                (model_name, status, remark, optimize_prompt, optimizer_base_url, optimizer_api_key, optimizer_model,
                 optimizer_system_prompt, optimizer_json_mode, optimizer_timeout_ms, optimizer_send_media, optimizer_allow_http, optimizer_debug)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                model_name,
                status !== undefined ? status : 1,
                remark || null,
                ...Object.values(optimizer)
            ]);
            const modelId = result.insertId;
            for (const binding of bindings || []) {
                const item = normalizeBinding(binding);
                await db.run(`INSERT INTO model_bindings
                    (logical_model_id, channel_id, route_path, poll_path, api_key, is_async, proxy_content, error_passthrough, poll_throttle, req_mapping, resp_mapping, poll_mapping, weight, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [modelId, ...Object.values(item)]);
            }
            res.json({ success: true, id: modelId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/models/:id", adminAuth, async (req, res) => {
        const { model_name, status, remark, bindings } = req.body;
        const optimizer = normalizeOptimizerConfig(req.body);
        try {
            await db.run(`UPDATE logical_models SET model_name=?, status=?, remark=?,
                optimize_prompt=?, optimizer_base_url=?, optimizer_api_key=?, optimizer_model=?,
                optimizer_system_prompt=?, optimizer_json_mode=?, optimizer_timeout_ms=?, optimizer_send_media=?,
                optimizer_allow_http=?, optimizer_debug=?
                WHERE id=?`, [
                model_name,
                status !== undefined ? status : 1,
                remark || null,
                ...Object.values(optimizer),
                req.params.id
            ]);
            if (Array.isArray(bindings)) {
                for (const binding of bindings) {
                    const item = normalizeBinding(binding);
                    if (binding.id) {
                        await db.run(`UPDATE model_bindings SET channel_id=?, route_path=?, poll_path=?, api_key=?, is_async=?, proxy_content=?, error_passthrough=?, poll_throttle=?,
                            req_mapping=?, resp_mapping=?, poll_mapping=?, weight=?, status=? WHERE id=? AND logical_model_id=?`,
                            [...Object.values(item), binding.id, req.params.id]);
                    } else {
                        await db.run(`INSERT INTO model_bindings
                            (logical_model_id, channel_id, route_path, poll_path, api_key, is_async, proxy_content, error_passthrough, poll_throttle, req_mapping, resp_mapping, poll_mapping, weight, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.params.id, ...Object.values(item)]);
                    }
                }
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete("/models/:id", adminAuth, async (req, res) => {
        try {
            const model = await db.get("SELECT id, status FROM logical_models WHERE id = ?", [req.params.id]);
            if (!model) return res.status(404).json({ error: "模型不存在" });
            const tasks = await db.get(`SELECT COUNT(*) AS count FROM async_tasks
                WHERE logical_model_id = ?
                  AND (status IS NULL OR status NOT IN ('completed', 'succeeded', 'success', 'done', 'finished', 'failed', 'rejected', 'error', 'cancelled', 'canceled'))`, [req.params.id]);
            if (Number(tasks && tasks.count) > 0) {
                return res.status(409).json({ error: "模型存在进行中的任务，请等待任务完成后再删除" });
            }
            await db.run("UPDATE logical_models SET status=0 WHERE id=?", [req.params.id]);
            res.json({ success: true, status: 0 });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get("/models/:id/bindings", adminAuth, async (req, res) => {
        try { res.json(await db.all(`SELECT b.*, c.name AS channel_name FROM model_bindings b JOIN channels c ON c.id=b.channel_id WHERE b.logical_model_id=? ORDER BY b.id`, [req.params.id])); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/models/:id/bindings", adminAuth, async (req, res) => {
        try {
            const item = normalizeBinding(req.body);
            await db.run(`INSERT INTO model_bindings
                (logical_model_id, channel_id, route_path, poll_path, api_key, is_async, proxy_content, error_passthrough, poll_throttle, req_mapping, resp_mapping, poll_mapping, weight, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.params.id, ...Object.values(item)]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/bindings/:id", adminAuth, async (req, res) => {
        try {
            const item = normalizeBinding(req.body);
            await db.run(`UPDATE model_bindings SET channel_id=?, route_path=?, poll_path=?, api_key=?, is_async=?, proxy_content=?, error_passthrough=?, poll_throttle=?,
                req_mapping=?, resp_mapping=?, poll_mapping=?, weight=?, status=? WHERE id=?`, [...Object.values(item), req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete("/bindings/:id", adminAuth, async (req, res) => {
        try {
            await db.run("UPDATE model_bindings SET status=0 WHERE id=?", [req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Global defaults for the optional prompt optimizer. Per-model columns still
    // win at request time, so turning a model on never breaks when these change.
    router.get("/optimizer/settings", adminAuth, async (req, res) => {
        try { res.json(await readOptimizerDefaults(db)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/optimizer/settings", adminAuth, async (req, res) => {
        try {
            const saved = await writeOptimizerDefaults(db, req.body || {});
            res.json({ success: true, settings: saved });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Connectivity check: runs one short text-only optimization request so the
    // operator can confirm URL, key and model name without creating a task.
    router.post("/optimizer/test", adminAuth, async (req, res) => {
        try {
            const defaults = await readOptimizerDefaults(db);
            const config = buildOptimizerTestConfig(defaults, req.body || {});
            if (!config.optimizer_base_url) {
                return res.status(400).json({ success: false, error: "请先填写提示词优化接口地址" });
            }
            if (!config.optimizer_api_key) {
                return res.status(400).json({ success: false, error: "请先填写提示词优化接口密钥" });
            }
            const started = Date.now();
            const { trace } = await optimizeWithConfig(OPTIMIZER_TEST_PAYLOAD, config);
            const durationMs = Date.now() - started;
            if (!trace || !trace.optimized) {
                return res.json({
                    success: false,
                    duration_ms: durationMs,
                    error: (trace && trace.reason) || "优化接口未返回可用的提示词"
                });
            }
            return res.json({
                success: true,
                duration_ms: durationMs,
                model: trace.model,
                optimized_prompt: trace.optimized_prompt,
                original_prompt: trace.original_prompt,
                meta: {
                    mode: trace.mode,
                    duration_sec: trace.duration_sec,
                    ratio: trace.ratio,
                    shot_count: trace.shot_count
                }
            });
        } catch (e) {
            res.json({ success: false, error: formatOptimizerError(e) });
        }
    });

    router.get("/keys", adminAuth, async (req, res) => {
        try { res.json(await db.all("SELECT * FROM gateway_keys ORDER BY id")); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/keys", adminAuth, async (req, res) => {
        const { api_key, quota, status } = req.body;
        try {
            await db.run("INSERT INTO gateway_keys (api_key, quota, status) VALUES (?, ?, ?)", [api_key, quota || 0, status !== undefined ? status : 1]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/keys/:id", adminAuth, async (req, res) => {
        const { quota, status } = req.body;
        try {
            await db.run("UPDATE gateway_keys SET quota=?, status=? WHERE id=?", [quota, status !== undefined ? status : 1, req.params.id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete("/keys/:id", adminAuth, async (req, res) => {
        try {
            const key = await db.get("SELECT id, status FROM gateway_keys WHERE id = ?", [req.params.id]);
            if (!key) return res.status(404).json({ error: "网关密钥不存在" });
            const tasks = await db.get(`SELECT COUNT(*) AS count FROM async_tasks
                WHERE gw_key_id = ?
                  AND (status IS NULL OR status NOT IN ('completed', 'succeeded', 'success', 'done', 'finished', 'failed', 'rejected', 'error', 'cancelled', 'canceled'))`, [req.params.id]);
            if (Number(tasks && tasks.count) > 0) {
                return res.status(409).json({ error: "网关密钥仍有关联中的任务，请等待任务完成后再删除" });
            }
            await db.run("UPDATE gateway_keys SET status=0 WHERE id=?", [req.params.id]);
            res.json({ success: true, status: 0 });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    return router;
};