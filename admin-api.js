const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin-password";
const ADMIN_TOKEN = crypto.createHash("sha256").update(ADMIN_PASS).digest("hex");

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
        req_mapping: binding.req_mapping || "{}",
        resp_mapping: binding.resp_mapping || "{}",
        poll_mapping: binding.poll_mapping || "{}",
        weight: Math.max(Number(binding.weight || 1), 1),
        status: binding.status !== undefined ? (binding.status ? 1 : 0) : 1
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

module.exports = function(db) {
    router.get("/channels", adminAuth, async (req, res) => {
        try { res.json(await db.all("SELECT * FROM channels ORDER BY id")); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/channels", adminAuth, async (req, res) => {
        const { name, base_url, api_key, status } = req.body;
        try {
            await db.run("INSERT INTO channels (name, base_url, api_key, status) VALUES (?, ?, ?, ?)", [name, base_url, api_key || null, status !== undefined ? status : 1]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/channels/:id", adminAuth, async (req, res) => {
        const { name, base_url, api_key, status } = req.body;
        try {
            await db.run("UPDATE channels SET name=?, base_url=?, api_key=?, status=? WHERE id=?", [name, base_url, api_key || null, status !== undefined ? status : 1, req.params.id]);
            res.json({ success: true });
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
        const { model_name, status, bindings } = req.body;
        try {
            const result = await db.run("INSERT INTO logical_models (model_name, status) VALUES (?, ?)", [model_name, status !== undefined ? status : 1]);
            const modelId = result.insertId;
            for (const binding of bindings || []) {
                const item = normalizeBinding(binding);
                await db.run(`INSERT INTO model_bindings
                    (logical_model_id, channel_id, route_path, poll_path, api_key, is_async, req_mapping, resp_mapping, poll_mapping, weight, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [modelId, ...Object.values(item)]);
            }
            res.json({ success: true, id: modelId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/models/:id", adminAuth, async (req, res) => {
        const { model_name, status, bindings } = req.body;
        try {
            await db.run("UPDATE logical_models SET model_name=?, status=? WHERE id=?", [model_name, status !== undefined ? status : 1, req.params.id]);
            if (Array.isArray(bindings)) {
                for (const binding of bindings) {
                    const item = normalizeBinding(binding);
                    if (binding.id) {
                        await db.run(`UPDATE model_bindings SET channel_id=?, route_path=?, poll_path=?, api_key=?, is_async=?,
                            req_mapping=?, resp_mapping=?, poll_mapping=?, weight=?, status=? WHERE id=? AND logical_model_id=?`,
                            [...Object.values(item), binding.id, req.params.id]);
                    } else {
                        await db.run(`INSERT INTO model_bindings
                            (logical_model_id, channel_id, route_path, poll_path, api_key, is_async, req_mapping, resp_mapping, poll_mapping, weight, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.params.id, ...Object.values(item)]);
                    }
                }
            }
            res.json({ success: true });
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
                (logical_model_id, channel_id, route_path, poll_path, api_key, is_async, req_mapping, resp_mapping, poll_mapping, weight, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.params.id, ...Object.values(item)]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/bindings/:id", adminAuth, async (req, res) => {
        try {
            const item = normalizeBinding(req.body);
            await db.run(`UPDATE model_bindings SET channel_id=?, route_path=?, poll_path=?, api_key=?, is_async=?,
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

    return router;
};
