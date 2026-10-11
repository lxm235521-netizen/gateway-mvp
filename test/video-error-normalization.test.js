// The downstream contract for a video task is `error: { code, message }`.
// Bindings produce that via their own poll_mapping JSONata, and older channel
// configs still emit the legacy flat form (`error: "<text>"` + top-level
// `error_code`). server.js normalizes the mapping output so every channel -
// including tasks whose poll_mapping_snapshot predates the fix - answers alike.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const plain = value => JSON.parse(JSON.stringify(value));

async function loadServer() {
    const filename = path.resolve(__dirname, '../server.js');
    const mod = { exports: {} };
    const nativeRequire = createRequire(filename);
    const db = {
        async all() { throw Error('Unexpected query'); },
        async get() { throw Error('Unexpected query'); },
        async run() { throw Error('Unexpected query'); }
    };
    const axios = { async get() { throw Error('Unexpected request'); }, async post() { throw Error('Unexpected request'); } };
    function req(name) {
        if (name === './db') return db;
        if (name === 'axios') return axios;
        if (name === 'morgan') return () => (_req, _res, next) => next();
        return nativeRequire(name);
    }
    const context = { require: req, module: mod, exports: mod.exports, __dirname: path.dirname(filename), process, console: { log() {}, error() {} }, Buffer, URL };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return mod.exports;
}

test('normalizeVideoError turns the legacy flat shape into an error object', async () => {
    const { __internal } = await loadServer();
    // server.js is loaded in its own VM context, so results are re-plained before
    // strict comparison (their prototypes are not this realm's Object.prototype).
    const { normalizeVideoError: normalizeRaw } = __internal;
    const normalizeVideoError = input => plain(normalizeRaw(input));

    // The reported case: a string error plus a non-allowlisted upstream code.
    assert.deepEqual(
        normalizeVideoError({ status: 'failed', progress: 100, error: '生成任务超过 30 分钟未完成', error_code: 'upstream_failed' }),
        { status: 'failed', progress: 100, error: { code: 'video_generation_failed', message: '生成任务超过 30 分钟未完成' }, error_code: 'video_generation_failed' }
    );

    // Semantic codes survive normalization.
    for (const code of ['video_generation_cancelled', 'reference_image_download_failed', 'gpu_out_of_memory', 'content_moderation']) {
        const out = normalizeVideoError({ status: 'failed', error: 'boom', error_code: code });
        assert.equal(out.error.code, code);
        assert.equal(out.error.message, 'boom');
    }

    // An already-nested error keeps its message and is canonicalized to { code, message }.
    const nested = normalizeVideoError({ status: 'failed', error: { message: '参考图下载失败', code: 'reference_image_download_failed' }, error_code: 'reference_image_download_failed' });
    assert.deepEqual(nested.error, { code: 'reference_image_download_failed', message: '参考图下载失败' });

    // An upstream error object with only a message still yields a usable code.
    assert.deepEqual(
        normalizeVideoError({ status: 'failed', error: { msg: 'provider exploded' } }).error,
        { code: 'video_generation_failed', message: 'provider exploded' }
    );

    // A failed task with no upstream text still describes itself.
    assert.deepEqual(normalizeVideoError({ status: 'failed', error: null }).error, { code: 'video_generation_failed', message: 'Video generation failed' });
    assert.deepEqual(normalizeVideoError({ status: 'failed' }).error, { code: 'video_generation_failed', message: 'Video generation failed' });

    // Non-failed states never carry an error, so a stale string cannot leak through.
    assert.equal(normalizeVideoError({ status: 'completed', progress: 100, error: '', error_code: 'upstream_failed' }).error, null);
    assert.equal(normalizeVideoError({ status: 'processing', error: null }).error, null);
    assert.equal(normalizeVideoError({ status: 'completed', error: '', error_code: 'upstream_failed' }).error_code, null);

    // Whitespace-only text is treated as missing.
    assert.deepEqual(normalizeVideoError({ status: 'failed', error: '   ', error_code: '  ' }).error, { code: 'video_generation_failed', message: 'Video generation failed' });
});

test('GET /v1/videos/:task_id returns the normalized error for a legacy poll_mapping_snapshot', async t => {
    const legacyResult = {
        status: 'failed',
        progress: 100,
        object: 'video.generation',
        model: 'Seedance 2.0 Fast',
        created_at: 1791700026,
        completed_at: 1791701826,
        video_url: '',
        result_url: '',
        upstream_result_url: '',
        // Legacy flat shape: `error` is a string and the code sits at the top level.
        error: '生成任务超过 30 分钟未完成',
        error_code: 'upstream_failed'
    };
    const task = {
        gw_task_id: 'a2f976b7-975c-4a06-9dcc-a42592aa8b63',
        up_task_id: 'task_p1tdzrU6NYjwCB7BkYV5Ea0CO5RvLbAl',
        gw_key_id: null,
        binding_id: 217,
        upstream_base_url: 'http://upstream.invalid',
        poll_path_snapshot: '/v1/tasks/${up_task_id}',
        // Emits the frozen legacy shape verbatim, exactly like channel 33's snapshot.
        poll_mapping_snapshot: `{ "status": "failed", "progress": 100, "object": "video.generation", "model": "Seedance 2.0 Fast", "created_at": 1791700026, "completed_at": 1791701826, "video_url": "", "result_url": "", "upstream_result_url": "", "error": "生成任务超过 30 分钟未完成", "error_code": "upstream_failed" }`,
        upstream_api_key_snapshot: 'channel-key',
        upstream_auth_type_snapshot: 'bearer',
        proxy_content_snapshot: 0,
        poll_throttle_snapshot: 0
    };

    const filename = path.resolve(__dirname, '../server.js');
    const nativeRequire = createRequire(filename);
    const db = {
        async all() { throw Error('Unexpected query'); },
        async get(sql, params) {
            if (sql.includes('FROM gateway_keys')) return params[0] === 'gateway-key' ? { id: 1, status: 1, quota: 100, used_quota: 0 } : null;
            if (sql.includes('FROM async_tasks')) return params[0] === task.gw_task_id ? task : undefined;
            throw Error('Unexpected query: ' + sql);
        },
        async run(sql) {
            if (sql.includes('UPDATE async_tasks')) return { affectedRows: 1, insertId: 0 };
            throw Error('Unexpected query: ' + sql);
        }
    };
    const axios = {
        async get(url) {
            assert.equal(url, 'http://upstream.invalid/v1/tasks/task_p1tdzrU6NYjwCB7BkYV5Ea0CO5RvLbAl');
            return { status: 200, data: legacyResult };
        },
        async post() { throw Error('Unexpected request'); }
    };
    const mod = { exports: {} };
    function req(name) {
        if (name === './db') return db;
        if (name === 'axios') return axios;
        if (name === 'morgan') return () => (_req, _res, next) => next();
        return nativeRequire(name);
    }
    const context = { require: req, module: mod, exports: mod.exports, __dirname: path.dirname(filename), process, console: { log() {}, error() {} }, Buffer, URL };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });

    const server = mod.exports.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = 'http://127.0.0.1:' + server.address().port;

    const res = await fetch(`${base}/v1/videos/${task.gw_task_id}`, { headers: { Authorization: 'Bearer gateway-key' } });
    assert.equal(res.status, 200);
    const body = plain(await res.json());

    assert.equal(typeof body.error, 'object');
    assert.deepEqual(body.error, { code: 'video_generation_failed', message: '生成任务超过 30 分钟未完成' });
    // Identity fields are still overwritten with the gateway task id.
    assert.equal(body.id, task.gw_task_id);
    assert.equal(body.task_id, task.gw_task_id);
    assert.equal(body.status, 'failed');
    assert.equal(body.progress, 100);
    assert.equal(body.object, 'video.generation');
    assert.equal(body.error_code, 'video_generation_failed');
});
