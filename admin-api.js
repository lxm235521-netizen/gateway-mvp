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

module.exports = function(db) {
    router.get("/channels", adminAuth, async (req, res) => {
        try {
            const channels = await db.all("SELECT * FROM channels");
            res.json(channels);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/channels", adminAuth, async (req, res) => {
        const { name, base_url, api_key, status } = req.body;
        try {
            await db.run("INSERT INTO channels (name, base_url, api_key, status) VALUES (?, ?, ?, ?)", [name, base_url, api_key, status !== undefined ? status : 1]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/channels/:id", adminAuth, async (req, res) => {
        const { id } = req.params;
        const { name, base_url, api_key, status } = req.body;
        try {
            await db.run(
                "UPDATE channels SET name=?, base_url=?, api_key=?, status=? WHERE id=?",
                [name, base_url, api_key, status !== undefined ? status : 1, id]
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    router.get("/models", adminAuth, async (req, res) => {
        try {
            const models = await db.all("SELECT m.*, c.name as channel_name FROM channel_models m LEFT JOIN channels c ON m.channel_id = c.id");
            res.json(models);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/models", adminAuth, async (req, res) => {
        const { channel_id, model_name, route_path, poll_path, api_key, is_async, req_mapping, resp_mapping, poll_mapping, weight, status } = req.body;
        try {
            await db.run(
                "INSERT INTO channel_models (channel_id, model_name, route_path, poll_path, api_key, is_async, req_mapping, resp_mapping, poll_mapping, weight, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [channel_id, model_name, route_path, poll_path, api_key, is_async || 0, req_mapping, resp_mapping, poll_mapping, weight || 1, status !== undefined ? status : 1]
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    
    router.put("/models/:id", adminAuth, async (req, res) => {
        const { id } = req.params;
        const { channel_id, model_name, route_path, poll_path, api_key, is_async, req_mapping, resp_mapping, poll_mapping, weight, status } = req.body;
        try {
            await db.run(
                "UPDATE channel_models SET channel_id=?, model_name=?, route_path=?, poll_path=?, api_key=?, is_async=?, req_mapping=?, resp_mapping=?, poll_mapping=?, weight=?, status=? WHERE id=?",
                [channel_id, model_name, route_path, poll_path, api_key, is_async || 0, req_mapping, resp_mapping, poll_mapping, weight || 1, status !== undefined ? status : 1, id]
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get("/keys", adminAuth, async (req, res) => {
        try {
            const keys = await db.all("SELECT * FROM gateway_keys");
            res.json(keys);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post("/keys", adminAuth, async (req, res) => {
        const { api_key, quota, status } = req.body;
        try {
            await db.run(
                "INSERT INTO gateway_keys (api_key, quota, status) VALUES (?, ?, ?)",
                [api_key, quota || 0, status !== undefined ? status : 1]
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put("/keys/:id", adminAuth, async (req, res) => {
        const { id } = req.params;
        const { quota, status } = req.body;
        try {
            await db.run(
                "UPDATE gateway_keys SET quota=?, status=? WHERE id=?",
                [quota, status !== undefined ? status : 1, id]
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    return router;
}