"use strict";

// Integration tests for the per-model prompt-optimization step.
//
// server.js is loaded the same way test/vylai-minimax.test.js does it: inside a
// vm context with injected ./db and axios fakes. Because the prompt-optimizer
// service module is pulled in through native require, it captures the same axios
// fake, which lets the tests intercept the optimizer call and the upstream call
// separately.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { createRequire } = require("node:module");
const { once } = require("node:events");

const plain = value => JSON.parse(JSON.stringify(value));

// A minimal stand-in for the external optimizer. It records what the gateway
// sent and replies with a canned OpenAI-shaped completion, so the suite needs no
// network access and no credentials. By default it answers the JSON-mode request
// with the documented structured payload; plainTextOnly replies with raw text.
async function startOptimizerStub(options = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        req.on("end", () => {
            let body = null;
            try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
            calls.push({ url: req.url, method: req.method, headers: req.headers, body });
            if (options.status && options.status !== 200) {
                res.writeHead(options.status, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "stub optimizer failure" } }));
                return;
            }
            // "plain" exercises the documented text mode; "json" (default) the
            // structured mode the docs recommend asking for.
            const content = options.responseFormat === "plain"
                ? "OPTIMIZED_PLAIN_TEXT\n\n<!-- H3 | mode: T2VA -->"
                : JSON.stringify({ mode: "T2VA", duration_sec: 8, ratio: "16:9", shot_count: 2, prompt: "OPTIMIZED_JSON_PROMPT" });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-stub", choices: [{ index: 0, message: { role: "assistant", content } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        baseUrl: "http://127.0.0.1:" + server.address().port,
        calls,
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })
    };
}

function makeOptimizerConfig(baseUrl, overrides = {}) {
    return Object.assign({
        optimize_prompt: 1,
        optimizer_base_url: baseUrl,
        optimizer_api_key: "optimizer-key",
        optimizer_model: "h3-prompt-writing",
        optimizer_system_prompt: null,
        optimizer_json_mode: 1,
        optimizer_timeout_ms: 30000,
        optimizer_send_media: "image",
        // The test stub listens on plain http, which needs the explicit opt-in.
        optimizer_allow_http: 1,
        optimizer_debug: 0
    }, overrides);
}

// server.js and admin-api.js are loaded with injected ./db and axios fakes. The
// prompt-optimizer service resolves axios through Node's own cache (it is loaded
// by require, not by the vm context), so the fakes are placed in that cache too
// and the gateway modules are evicted before each boot so that every test gets
// its own stubs instead of an earlier test's captures.
const CACHED_MODULES = ["./prompt-optimizer-service", "./prompt-optimizer", "./upstream-auth", "./admin-api", "./gateway-settings"];

function preloadFakes(nativeRequire, fakes) {
    for (const [request, exports] of Object.entries(fakes)) {
        nativeRequire.cache[nativeRequire.resolve(request)] = {
            id: request,
            filename: request,
            loaded: true,
            exports
        };
    }
}

function evictModules(nativeRequire) {
    for (const request of CACHED_MODULES) {
        delete nativeRequire.cache[nativeRequire.resolve(request)];
    }
}

// One axios instance is shared by every gateway layer for the whole file. Node's
// module cache makes the prompt-optimizer service capture whichever axios was
// installed first, so instead of swapping instances the tests swap the upstream
// behavior behind a stable proxy.
const axiosProxy = {
    upstreamPosts: [],
    realPosts: [],
    upstreamHandler: null,
    isUpstream: url => /upstream\.invalid/.test(url)
};

function setupAxios(onUpstreamPost) {
    axiosProxy.upstreamHandler = onUpstreamPost || null;
    axiosProxy.upstreamPosts = [];
    axiosProxy.realPosts = [];

    axiosProxy.post = async function (url, data, options) {
        if (!axiosProxy.isUpstream(url)) {
            axiosProxy.realPosts.push({ url, data, options, status: "pending" });
            const response = await fetch(url, {
                method: "POST",
                headers: (options && options.headers) || { "Content-Type": "application/json" },
                body: typeof data === "string" ? data : JSON.stringify(data)
            });
            const text = await response.text();
            let parsed = text;
            try { parsed = JSON.parse(text); } catch (e) { /* keep raw text */ }
            axiosProxy.realPosts[axiosProxy.realPosts.length - 1].status = response.status;
            if (!response.ok) {
                const error = new Error("Request failed with status code " + response.status);
                error.response = { status: response.status, data: parsed, headers: {} };
                throw error;
            }
            return { status: response.status, data: parsed, headers: {} };
        }
        axiosProxy.upstreamPosts.push({ url, data, options });
        return axiosProxy.upstreamHandler
            ? axiosProxy.upstreamHandler(url, data, options)
            : { status: 200, data: { id: "up-1" } };
    };

    axiosProxy.get = async function (url, options) {
        if (axiosProxy.isUpstream(url)) {
            throw new Error("Unexpected upstream GET " + url);
        }
        const response = await fetch(url);
        if (options && options.responseType === "arraybuffer") {
            return {
                status: response.status,
                headers: { "content-type": response.headers.get("content-type") || "" },
                data: Buffer.from(await response.arrayBuffer())
            };
        }
        return { status: response.status, data: await response.json(), headers: {} };
    };

    return axiosProxy;
}

// Every test starts with a clean routing table.
test.beforeEach(() => { setupAxios(null); });

// Boots server.js with injected db/axios fakes.
async function bootServer({ binding, db, axios }) {
    const filename = path.resolve(__dirname, "../server.js");
    const nativeRequire = createRequire(filename);
    const mod = { exports: {} };
    function req(name) {
        if (name === "./db") return db;
        if (name === "axios") return axiosProxy;
        if (name === "morgan") return () => (unusedReq, unusedRes, next) => next();
        return nativeRequire(name);
    }
    preloadFakes(nativeRequire, { axios: axiosProxy });
    // Drop anything a previous boot captured so this boot gets these fakes.
    evictModules(nativeRequire);
    const context = {
        require: req,
        module: mod,
        exports: mod.exports,
        __dirname: path.dirname(filename),
        process,
        console: { log() {}, error() {} },
        Buffer,
        URL
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
    const server = mod.exports.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        binding,
        base: "http://127.0.0.1:" + server.address().port,
        close: async () => {
            await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
            evictModules(nativeRequire);
        }
    };
}

// Shared gateway-side fakes: one video binding plus an optional OpenAI-style
// optimizer binding for the /v1/chat/completions route. `settings` stands in for
// the saved global optimizer defaults.
function makeDb(binding, settings = {}) {
    const tasks = new Map();
    const db = {
        tasks,
        async all(sql, params) {
            if (sql.includes("FROM logical_models lm")) return [binding(params[0])];
            throw new Error("Unexpected all() query: " + sql);
        },
        async get(sql, params) {
            if (sql.includes("FROM gateway_keys")) {
                return params[0] === "gateway-key" ? { id: 1, status: 1, quota: 100, used_quota: 0 } : null;
            }
            if (sql.includes("FROM gateway_settings")) {
                return Object.keys(settings).length > 0 ? { setting_value: JSON.stringify(settings) } : null;
            }
            throw new Error("Unexpected get() query: " + sql);
        },
        async run(sql, params) {
            if (sql.includes("INSERT INTO async_tasks")) {
                const names = ["gw_task_id", "up_task_id", "gw_key_id", "logical_model_id", "binding_id", "channel_id",
                    "upstream_base_url", "poll_path_snapshot", "poll_mapping_snapshot", "upstream_api_key_snapshot",
                    "proxy_content_snapshot", "poll_throttle_snapshot", "upstream_auth_type_snapshot",
                    "original_prompt", "optimized_prompt", "prompt_optimizer_meta"];
                assert.equal((sql.match(/\?/g) || []).length, params.length, "INSERT placeholder count must match params");
                tasks.set(params[0], Object.fromEntries(names.map((name, i) => [name, params[i]])));
                return { affectedRows: 1, insertId: 1 };
            }
            return { affectedRows: 1, insertId: 1 };
        }
    };
    return db;
}

function videoBinding(overrides = {}) {
    return {
        id: 5,
        binding_id: 5,
        logical_model_id: 1,
        channel_id: 9,
        model_name: "test-video",
        route_path: "/v1/videos",
        poll_path: "/v1/videos/${up_task_id}",
        api_key: null,
        channel_api_key: "channel-key",
        channel_auth_type: "bearer",
        channel_name: "Test Channel",
        base_url: "https://upstream.invalid",
        convert_base64_to_url: 0,
        is_async: 1,
        proxy_content: 0,
        poll_throttle: 0,
        req_mapping: '{"model": "up-model", "prompt": prompt, "image_urls": $count(images) > 0 ? images : $notdefined}',
        resp_mapping: '{"task_id": id, "status": "queued"}',
        poll_mapping: '{"status": status, "video_url": video_url}',
        weight: 1,
        status: 1,
        optimize_prompt: 0,
        optimizer_base_url: null,
        optimizer_api_key: null,
        optimizer_model: "h3-prompt-writing",
        optimizer_system_prompt: null,
        optimizer_json_mode: 1,
        optimizer_timeout_ms: 30000,
        optimizer_send_media: "image",
        optimizer_debug: 0,
        ...overrides
    };
}

test("video submit: optimized prompt replaces the original before mapping upstream", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    const binding = videoBinding(makeOptimizerConfig(stub.baseUrl, { optimize_prompt: 1, optimizer_debug: 1 }));
    const db = makeDb(() => binding);
    const axios = setupAxios(null);

    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/videos", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-video", prompt: "原始提示词", seconds: "10" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    // 1. The optimizer received the caller's prompt and the model's config.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "/v1/chat/completions");
    assert.equal(stub.calls[0].headers.authorization, "Bearer optimizer-key");
    assert.equal(stub.calls[0].body.model, "h3-prompt-writing");
    assert.match(stub.calls[0].body.messages[1].content[0].text, /原始提示词/);

    // 2. The upstream request carries the optimized prompt, not the original.
    assert.equal(axios.upstreamPosts.length, 1);
    assert.equal(axios.upstreamPosts[0].data.prompt, "OPTIMIZED_JSON_PROMPT");
    assert.equal(axios.upstreamPosts[0].data.model, "up-model");

    // 3. The task snapshot and the debug payload expose what happened.
    const task = db.tasks.get(body.id);
    assert.equal(task.original_prompt, "原始提示词");
    assert.equal(task.optimized_prompt, "OPTIMIZED_JSON_PROMPT");
    const meta = JSON.parse(task.prompt_optimizer_meta);
    assert.equal(meta.optimized, true);
    assert.equal(meta.mode, "T2VA");
    assert.equal(meta.shot_count, 2);
    assert.equal(body.prompt_optimizer.optimized, true);
});

test("video submit: optimizer failure falls back to the original prompt", async t => {
    const stub = await startOptimizerStub({ status: 500 });
    t.after(() => stub.close());

    const binding = videoBinding(makeOptimizerConfig(stub.baseUrl, { optimize_prompt: 1 }));
    const db = makeDb(() => binding);
    const axios = setupAxios(null);

    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/videos", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-video", prompt: "原始提示词", seconds: "10" })
    });
    // The generation must still be submitted upstream.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(axios.upstreamPosts.length, 1);

    const task = db.tasks.get(body.id);
    assert.equal(task.optimized_prompt, null);
    const meta = JSON.parse(task.prompt_optimizer_meta);
    assert.equal(meta.optimized, false);
    assert.equal(meta.fallback, true);
    assert.match(meta.reason, /HTTP 500/);
    // Failures are always surfaced, even without debug enabled.
    assert.equal(body.prompt_optimizer.optimized, false);
    assert.match(body.prompt_optimizer.reason, /HTTP 500/);
});

test("video submit: a plain-http optimizer is skipped unless the model opts in", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    // The test stub is http; the per-model opt-in is off, so the key must not be sent.
    const binding = videoBinding(makeOptimizerConfig(stub.baseUrl, { optimize_prompt: 1, optimizer_allow_http: 0 }));
    const db = makeDb(() => binding);
    const axios = setupAxios(null);
    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/videos", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-video", prompt: "原始提示词" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(stub.calls.length, 0, "no request may be sent over plain http by default");
    assert.equal(axios.upstreamPosts[0].data.prompt, "原始提示词");
    assert.match(body.prompt_optimizer.reason, /http/);
});

test("video submit: a model with no optimizer settings inherits the global defaults", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    // The model only switches the feature on; the connection lives in settings.
    // optimizer_model keeps its column default, so that one field is not inherited.
    const binding = videoBinding({ optimize_prompt: 1, optimizer_model: "h3-prompt-writing" });
    const db = makeDb(() => binding, {
        optimizer_base_url: stub.baseUrl,
        optimizer_api_key: "global-key",
        optimizer_model: "global-model",
        optimizer_json_mode: 1,
        optimizer_timeout_ms: 30000,
        optimizer_send_media: "image",
        optimizer_allow_http: 1
    });
    const axios = setupAxios(null);
    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/videos", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-video", prompt: "原始提示词" })
    });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1, "global defaults must drive the optimizer call");
    assert.equal(stub.calls[0].url, "/v1/chat/completions");
    assert.equal(stub.calls[0].headers.authorization, "Bearer global-key");
    assert.equal(axios.upstreamPosts[0].data.prompt, "OPTIMIZED_JSON_PROMPT");
});

test("video submit: model settings win over the global defaults", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    const binding = videoBinding(makeOptimizerConfig(stub.baseUrl, { optimize_prompt: 1, optimizer_model: "model-level" }));
    const db = makeDb(() => binding, {
        optimizer_base_url: "http://127.0.0.1:1/never-called",
        optimizer_api_key: "global-key",
        optimizer_model: "global-model",
        optimizer_allow_http: 0
    });
    const axios = setupAxios(null);
    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/videos", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-video", prompt: "原始提示词" })
    });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].body.model, "model-level");
    assert.equal(stub.calls[0].headers.authorization, "Bearer optimizer-key");
    assert.equal(axios.upstreamPosts[0].data.prompt, "OPTIMIZED_JSON_PROMPT");
});

test("video submit: optimization disabled leaves the request untouched", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    const binding = videoBinding(makeOptimizerConfig(stub.baseUrl, { optimize_prompt: 0 }));
    const db = makeDb(() => binding);
    const axios = setupAxios(null);

    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/videos", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-video", prompt: "原始提示词" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(stub.calls.length, 0, "disabled models must not call the optimizer");
    assert.equal(axios.upstreamPosts[0].data.prompt, "原始提示词");
    assert.equal(body.prompt_optimizer, undefined);
    assert.equal(db.tasks.get(body.id).prompt_optimizer_meta, null);
});

test("video submit: upstream image URLs are inlined as data URLs for the optimizer", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    // A 1x1 PNG served over http, which the optimizer itself would reject.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==", "base64");
    const imageServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
    });
    imageServer.listen(0, "127.0.0.1");
    await once(imageServer, "listening");
    t.after(() => new Promise(resolve => { imageServer.closeAllConnections(); imageServer.close(resolve); }));
    const imageUrl = "http://127.0.0.1:" + imageServer.address().port + "/frame.png";

    const binding = videoBinding(makeOptimizerConfig(stub.baseUrl, { optimize_prompt: 1 }));
    const db = makeDb(() => binding);
    const axios = setupAxios(null);

    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/videos", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-video", prompt: "参考这张图改写", images: [imageUrl] })
    });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
    const parts = stub.calls[0].body.messages[1].content;
    const imagePart = parts.find(part => part.type === "image_url");
    assert.ok(imagePart, "optimizer request must include the image");
    assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
    assert.ok(!imagePart.image_url.url.includes(imageUrl), "the http URL must not be forwarded");
});

test("chat completions: the last user message is optimized", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    const binding = videoBinding({
        model_name: "test-chat",
        route_path: "/v1/chat/completions",
        is_async: 0,
        req_mapping: '{"model": "up-chat", "prompt": $string(messages[0].content)}',
        resp_mapping: '{"ok": true, "id": id}',
        ...makeOptimizerConfig(stub.baseUrl, { optimize_prompt: 1 })
    });
    const db = makeDb(() => binding);
    const axios = setupAxios(null);
    const server = await bootServer({ binding, db, axios });
    t.after(() => server.close());

    const res = await fetch(server.base + "/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer gateway-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test-chat", messages: [{ role: "user", content: "旧提示词" }] })
    });
    assert.equal(res.status, 200);
    assert.equal(await (await res.json()).ok, true);

    // The optimizer saw the user message, and the upstream received the rewritten text.
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].body.messages[1].content[0].text, /旧提示词/);
    assert.equal(axios.upstreamPosts.length, 1);
    assert.equal(axios.upstreamPosts[0].data.prompt, "OPTIMIZED_JSON_PROMPT");
});

// --- Admin API -------------------------------------------------------------

async function bootAdminServer(db) {
    const filename = path.resolve(__dirname, "../server.js");
    const nativeRequire = createRequire(filename);
    const mod = { exports: {} };
    function req(name) {
        if (name === "./db") return db;
        if (name === "axios") return axiosProxy;
        if (name === "morgan") return () => (unusedReq, unusedRes, next) => next();
        return nativeRequire(name);
    }
    preloadFakes(nativeRequire, { axios: axiosProxy });
    evictModules(nativeRequire);
    const context = {
        require: req, module: mod, exports: mod.exports,
        __dirname: path.dirname(filename), process,
        console: { log() {}, error() {} }, Buffer, URL
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
    const server = mod.exports.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        base: "http://127.0.0.1:" + server.address().port,
        close: async () => {
            await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
            evictModules(nativeRequire);
        }
    };
}

function adminHeaders() {
    const token = require("node:crypto").createHash("sha256").update(process.env.ADMIN_PASS || "admin-password").digest("hex");
    return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

test("admin: optimizer settings round-trip keeps the saved key when blank", async t => {
    const writes = [];
    let stored = null;
    const db = {
        async get(sql, params) {
            if (sql.includes("FROM gateway_settings")) return stored ? { setting_value: stored } : null;
            throw new Error("Unexpected get: " + sql);
        },
        async run(sql, params) {
            if (sql.includes("gateway_settings")) {
                writes.push({ sql, params });
                if (sql.startsWith("UPDATE")) { stored = params[0]; return { affectedRows: stored ? 1 : 0 }; }
                stored = params[1];
                return { affectedRows: 1 };
            }
            return { affectedRows: 1 };
        },
        async all() { return []; }
    };
    const axios = setupAxios(null);
    const server = await bootAdminServer(db);
    t.after(() => server.close());

    // First save stores the key.
    let res = await fetch(server.base + "/admin/optimizer/settings", {
        method: "PUT", headers: adminHeaders(),
        body: JSON.stringify({ enabled: 1, optimizer_base_url: "https://api.mmg.lat", optimizer_api_key: "sk-secret" })
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(stored).optimizer_api_key, "sk-secret");

    // A second save with a blank key must keep the stored one.
    res = await fetch(server.base + "/admin/optimizer/settings", {
        method: "PUT", headers: adminHeaders(),
        body: JSON.stringify({ enabled: 1, optimizer_base_url: "https://api.mmg.lat", optimizer_api_key: "" })
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(stored).optimizer_api_key, "sk-secret");

    // GET returns the saved settings.
    res = await fetch(server.base + "/admin/optimizer/settings", { headers: adminHeaders() });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).optimizer_base_url, "https://api.mmg.lat");
});

test("admin: connectivity test uses the saved settings and reports the result", async t => {
    const stub = await startOptimizerStub();
    t.after(() => stub.close());

    const stored = JSON.stringify({
        enabled: 1,
        optimize_prompt: 0,
        optimizer_base_url: stub.baseUrl,
        optimizer_api_key: "sk-secret",
        optimizer_model: "h3-prompt-writing",
        optimizer_json_mode: 1,
        optimizer_timeout_ms: 30000,
        optimizer_allow_http: 1,
        optimizer_send_media: "image"
    });
    const db = {
        async get(sql) {
            if (sql.includes("FROM gateway_settings")) return { setting_value: stored };
            throw new Error("Unexpected get: " + sql);
        },
        async run() { return { affectedRows: 1 }; },
        async all() { return []; }
    };
    const axios = setupAxios(null);
    const server = await bootAdminServer(db);
    t.after(() => server.close());

    const res = await fetch(server.base + "/admin/optimizer/test", { method: "POST", headers: adminHeaders(), body: "{}" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.optimized_prompt, "OPTIMIZED_JSON_PROMPT");
    assert.equal(body.meta.mode, "T2VA");
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].headers.authorization, "Bearer sk-secret");
    // The sample check must be text-only.
    assert.equal(stub.calls[0].body.messages[1].content.filter(part => part.type !== "text").length, 0);
});

test("admin: connectivity test rejects a missing address or key", async t => {
    const db = {
        async get(sql) { if (sql.includes("FROM gateway_settings")) return null; throw new Error("Unexpected get"); },
        async run() { return { affectedRows: 1 }; },
        async all() { return []; }
    };
    const axios = setupAxios(null);
    const server = await bootAdminServer(db);
    t.after(() => server.close());

    const res = await fetch(server.base + "/admin/optimizer/test", { method: "POST", headers: adminHeaders(), body: "{}" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /地址/);
});

test("admin: model create and update persist the optimizer columns", async t => {
    const statements = [];
    const db = {
        async get(sql) { if (sql.includes("FROM gateway_settings")) return null; throw new Error("Unexpected get: " + sql); },
        async run(sql, params) { statements.push({ sql, params }); return { affectedRows: 1, insertId: 7 }; },
        async all() { return []; }
    };
    const axios = setupAxios(null);
    const server = await bootAdminServer(db);
    t.after(() => server.close());

    const payload = {
        model_name: "with-optimizer",
        status: 1,
        remark: "",
        optimize_prompt: 1,
        optimizer_base_url: "https://api.mmg.lat",
        optimizer_api_key: "sk-abc",
        optimizer_model: "h3-prompt-writing",
        optimizer_timeout_ms: 90000,
        optimizer_send_media: "image,video",
        optimizer_debug: 1,
        bindings: [{
            channel_id: 1, route_path: "/v1/videos", is_async: 1,
            req_mapping: "{}", resp_mapping: "{}", poll_mapping: "{}"
        }]
    };

    let res = await fetch(server.base + "/admin/models", { method: "POST", headers: adminHeaders(), body: JSON.stringify(payload) });
    assert.equal(res.status, 200);

    const insert = statements.find(item => item.sql.includes("INSERT INTO logical_models"));
    assert.ok(insert, "the model insert must include the optimizer columns");
    assert.equal((insert.sql.match(/\?/g) || []).length, insert.params.length);
    assert.ok(insert.params.includes(90_000), "timeout must be persisted");
    assert.ok(insert.params.includes("image,video"), "media kinds must be normalized and persisted");
    assert.ok(insert.params.includes("sk-abc"), "the key must be persisted");

    // Partial update: omitting the optimizer block disables the feature rather
    // than leaving stale settings behind.
    statements.length = 0;
    res = await fetch(server.base + "/admin/models/3", {
        method: "PUT", headers: adminHeaders(),
        body: JSON.stringify({ model_name: "with-optimizer", status: 1, remark: "", bindings: [] })
    });
    assert.equal(res.status, 200);
    const update = statements.find(item => item.sql.includes("UPDATE logical_models"));
    assert.ok(update);
    assert.equal((update.sql.match(/\?/g) || []).length, update.params.length);
    assert.equal(update.params[3], 0, "optimize_prompt must default to 0");
    assert.equal(update.params[8], 1, "json mode must default to on");
    assert.equal(update.params[9], 120000, "timeout must default to 120s");
});
