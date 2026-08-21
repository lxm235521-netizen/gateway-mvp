const express = require("express");
const axios = require("axios");
const jsonata = require("jsonata");
const morgan = require("morgan");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");

const app = express();
app.use(express.json());
app.use(morgan("dev"));

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

app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    const { model } = req.body;
    try {
        const modelRecord = await db.get('SELECT m.*, c.base_url, c.api_key as channel_api_key FROM channel_models m JOIN channels c ON m.channel_id = c.id WHERE m.model_name = ? AND m.status = 1', [model]);
        if (!modelRecord) {
            return res.status(404).json({ error: 'Model not found or disabled' });
        }

        const upstreamPayload = await executeMapping(modelRecord.req_mapping, req.body);
        const upstreamKey = modelRecord.api_key || modelRecord.channel_api_key;
        const upstreamUrl = modelRecord.base_url + modelRecord.route_path;
        
        console.log('[Gateway POST completions] Routing to: ' + upstreamUrl);
        
        await db.run('UPDATE gateway_keys SET used_quota = used_quota + 1 WHERE id = ?', [req.gatewayKey.id]);

        const upstreamRes = await axios.post(upstreamUrl, upstreamPayload, {
            headers: { 'Authorization': 'Bearer ' + upstreamKey }
        });

        const gwResponse = await executeMapping(modelRecord.resp_mapping, upstreamRes.data);
        res.json(gwResponse);
    } catch (e) {
        console.error('Upstream error:', e.response ? e.response.data : e.message);
        res.status(500).json({ error: 'Upstream request failed', details: e.message });
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
        const upstreamUrl = modelRecord.base_url + modelRecord.route_path;
        
        console.log(`[Gateway POST] Routing to: ${upstreamUrl}`);
        const upstreamRes = await axios.post(upstreamUrl, upstreamPayload, {
            headers: { "Authorization": `Bearer ${upstreamKey}` }
        });

        const gwResponse = await executeMapping(modelRecord.resp_mapping, upstreamRes.data);
        
        if (modelRecord.is_async) {
            const gwTaskId = "task_" + crypto.randomBytes(16).toString("hex");
            const upTaskId = gwResponse.task_id || "unknown";
            
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
        if (taskRecord.status === 'completed' || taskRecord.status === 'failed') {
            return res.json({
                id: taskRecord.gw_task_id,
                status: taskRecord.status,
                message: "Task is already resolved."
            });
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
