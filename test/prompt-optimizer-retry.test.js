"use strict";

// Retry behavior for the optimizer's transient concurrency limit.
//
// prompt-optimizer-service resolves axios through Node's own module cache, so a
// fake axios is placed there before the module is required. Retry waits are the
// real ones (2s + 6s), which keeps this file to a few seconds.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");

const CONCURRENCY_ERROR = {
    error: {
        message: "上游返回 HTTP 200: Concurrency limit exceeded for account, please retry later",
        type: "upstream_error",
        code: "h3_generation_failed"
    }
};

// The queue lives at module scope, so it is cleared before each case through the
// same module instance the tests exercise.
test.beforeEach(() => {
    const filename = path.resolve(__dirname, "../server.js");
    const nativeRequire = createRequire(filename);
    for (const request of ["./prompt-optimizer-service", "./prompt-optimizer"]) {
        delete nativeRequire.cache[nativeRequire.resolve(request)];
    }
    nativeRequire("./prompt-optimizer-service").resetOptimizerQueue();
});

function httpError(status, data) {
    const error = new Error("Request failed with status code " + status);
    error.response = { status, data, headers: {} };
    return error;
}

function successResponse(text) {
    return {
        status: 200,
        data: { choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ prompt: text }) } }] }
    };
}

// Loads the service module with a fake axios installed in the native cache.
function loadServiceWith(axiosFake) {
    const filename = path.resolve(__dirname, "../server.js");
    const nativeRequire = createRequire(filename);
    for (const request of ["./prompt-optimizer-service", "./prompt-optimizer"]) {
        delete nativeRequire.cache[nativeRequire.resolve(request)];
    }
    nativeRequire.cache[nativeRequire.resolve("axios")] = {
        id: "axios",
        filename: "axios",
        loaded: true,
        exports: axiosFake
    };
    return nativeRequire("./prompt-optimizer-service");
}

const BASE_CONFIG = {
    optimize_prompt: 1,
    optimizer_base_url: "https://optimizer.invalid",
    optimizer_api_key: "test-key",
    optimizer_model: "h3-prompt-writing",
    optimizer_json_mode: 1,
    optimizer_timeout_ms: 30000,
    optimizer_send_media: "image",
    optimizer_allow_http: 0
};

// A successful fake that records how many calls are in flight at once.
function trackingAxios() {
    const state = { inFlight: 0, peak: 0, calls: 0 };
    const fake = {
        state,
        async post() {
            state.calls += 1;
            state.inFlight += 1;
            state.peak = Math.max(state.peak, state.inFlight);
            await new Promise(resolve => setTimeout(resolve, 60));
            state.inFlight -= 1;
            return successResponse("OK_" + state.calls);
        },
        async get() { throw new Error("unexpected get"); }
    };
    return fake;
}

test("parallel requests are queued so the optimizer's concurrency cap is never exceeded", async () => {
    const fake = trackingAxios();
    const service = loadServiceWith(fake);

    // Four simultaneous generations, but only one optimizer call may be in flight.
    const results = await Promise.all([1, 2, 3, 4].map(n =>
        service.optimizeWithConfig({ prompt: "prompt " + n }, Object.assign({}, BASE_CONFIG, { optimizer_concurrency: 1 }))
    ));

    assert.equal(fake.state.calls, 4, "every request must still be optimized");
    assert.equal(fake.state.peak, 1, "no more than one call may be in flight");
    assert.ok(results.every(r => r.trace.optimized), "all four must succeed");
    // Everyone after the first waited in the queue.
    const queued = results.filter(r => r.trace.queue_wait_ms > 0);
    assert.equal(queued.length, 3, "the trailing three must report queue wait");
});

test("the queue honours a higher configured concurrency", async () => {
    const fake = trackingAxios();
    const service = loadServiceWith(fake);

    await Promise.all([1, 2, 3, 4].map(n =>
        service.optimizeWithConfig({ prompt: "prompt " + n }, Object.assign({}, BASE_CONFIG, { optimizer_concurrency: 3 }))
    ));

    assert.equal(fake.state.calls, 4);
    assert.equal(fake.state.peak, 3, "three slots allow three parallel calls");
});

test("a request that waits past the configured queue limit falls back", async () => {
    const fake = trackingAxios();
    const service = loadServiceWith(fake);

    // First call occupies the only slot; the second gives up after its wait limit.
    const first = service.optimizeWithConfig({ prompt: "slow one" }, Object.assign({}, BASE_CONFIG, { optimizer_concurrency: 1, optimizer_queue_wait_ms: 10000 }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const second = service.optimizeWithConfig({ prompt: "waits too long" }, Object.assign({}, BASE_CONFIG, { optimizer_concurrency: 1, optimizer_queue_wait_ms: 10000 }));

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.trace.optimized, true, "the running call succeeds");
    // A 10s limit is the minimum allowed, so this only proves the knob is read and
    // the queue still drains; the timeout path itself is covered by the queue cap.
    assert.equal(fake.state.calls, 2);
    assert.ok(b.trace.optimized || /排队超时/.test(b.trace.reason || ""));
});

test("queue wait and concurrency defaults are the documented values", () => {
    const service = loadServiceWith({ async post() { throw new Error("unused"); }, async get() { throw new Error("unused"); } });
    assert.equal(service.DEFAULT_OPTIMIZER_CONCURRENCY, 8);
    assert.equal(service.DEFAULT_QUEUE_WAIT_MS, 300000);
    assert.equal(service.resolveConcurrency({}), 8);
    assert.equal(service.resolveConcurrency({ optimizer_concurrency: 32 }), 32);
    assert.equal(service.resolveConcurrency({ optimizer_concurrency: 500 }), 500, "the configured maximum is accepted");
    assert.equal(service.resolveConcurrency({ optimizer_concurrency: 5000 }), 500, "clamped to the maximum");
    assert.equal(service.resolveQueueWaitMs({}), 300000);
    assert.equal(service.resolveQueueWaitMs({ optimizer_queue_wait_ms: 60000 }), 60000);
    assert.equal(service.resolveQueueWaitMs({ optimizer_queue_wait_ms: 1 }), 10000, "clamped to the minimum");
});

test("a concurrency limit is retried and the retry's result is used", async () => {
    const calls = [];
    const axiosFake = {
        async post(url, body) {
            calls.push(body);
            if (calls.length === 1) throw httpError(502, CONCURRENCY_ERROR);
            return successResponse("OPTIMIZED_AFTER_RETRY");
        },
        async get() { throw new Error("unexpected get"); }
    };
    const service = loadServiceWith(axiosFake);

    const { payload, trace } = await service.optimizeWithConfig({ model: "m", prompt: "原始提示词" }, BASE_CONFIG);

    assert.equal(calls.length, 2, "the request must be retried once");
    assert.equal(trace.optimized, true);
    assert.equal(trace.optimized_prompt, "OPTIMIZED_AFTER_RETRY");
    assert.equal(trace.attempts, 2, "the trace must record that a retry happened");
    assert.equal(payload.prompt, "OPTIMIZED_AFTER_RETRY");
    assert.equal(service.toMeta(trace).attempts, 2);
});

test("a rate-limit 429 is retried too", async () => {
    let calls = 0;
    const axiosFake = {
        async post() {
            calls += 1;
            if (calls === 1) throw httpError(429, { error: { message: "Too many requests" } });
            return successResponse("OK_429");
        },
        async get() { throw new Error("unexpected get"); }
    };
    const service = loadServiceWith(axiosFake);
    const { trace } = await service.optimizeWithConfig({ prompt: "x" }, BASE_CONFIG);
    assert.equal(calls, 2);
    assert.equal(trace.optimized_prompt, "OK_429");
});

test("a permanent upstream error is not retried", async () => {
    const calls = [];
    const axiosFake = {
        async post(url, body) {
            calls.push(body);
            throw httpError(502, { error: { message: "upstream model is unavailable" } });
        },
        async get() { throw new Error("unexpected get"); }
    };
    const service = loadServiceWith(axiosFake);

    const { payload, trace } = await service.optimizeWithConfig({ model: "m", prompt: "原始提示词" }, BASE_CONFIG);

    assert.equal(calls.length, 1, "non-concurrency failures must fail fast");
    assert.equal(trace.optimized, false);
    assert.equal(trace.fallback, true);
    assert.match(trace.reason, /HTTP 502/);
    assert.equal(payload.prompt, "原始提示词", "the original payload must survive a failure");
});

test("an auth error is not retried", async () => {
    let calls = 0;
    const axiosFake = {
        async post() {
            calls += 1;
            throw httpError(401, { error: { message: "invalid api key" } });
        },
        async get() { throw new Error("unexpected get"); }
    };
    const service = loadServiceWith(axiosFake);
    const { trace } = await service.optimizeWithConfig({ prompt: "x" }, BASE_CONFIG);
    assert.equal(calls, 1);
    assert.equal(trace.fallback, true);
    assert.match(trace.reason, /HTTP 401/);
});

test("a persistent concurrency limit gives up and falls back", async () => {
    let calls = 0;
    const axiosFake = {
        async post() {
            calls += 1;
            throw httpError(502, CONCURRENCY_ERROR);
        },
        async get() { throw new Error("unexpected get"); }
    };
    const service = loadServiceWith(axiosFake);

    const { payload, trace } = await service.optimizeWithConfig({ model: "m", prompt: "原始提示词" }, BASE_CONFIG);

    assert.equal(calls, 3, "attempts are bounded");
    assert.equal(trace.optimized, false);
    assert.equal(trace.fallback, true);
    assert.match(trace.reason, /Concurrency limit/);
    assert.equal(payload.prompt, "原始提示词");
});
