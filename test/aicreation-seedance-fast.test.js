// 校验 AI 创作 Seedance 2.0 Fast 的渠道与映射（只跑本地表达式，不发起付费生成请求）。
const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { channel, models, bindings } = require('../scripts/aicreation-seedance-fast-config');

// 与上游文档 / 实测一致的响应样本。
const SUBMIT_RESPONSE = {
    billing: { credits_charged: 100, status: 'charged' },
    created: 1791352315,
    data: [],
    dedup: false,
    message: 'Task is still running; poll /v1/tasks/task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5.',
    model: 'Seedance 2.0 Fast',
    object: 'video.generation',
    status: 'pending',
    task_id: 'task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5'
};

const POLL_PENDING = {
    aspect_ratio: '16:9',
    completed_at: '',
    created_at: '2026-10-07T05:51:55Z',
    error: '',
    error_code: '',
    model: 'Seedance 2.0 Fast',
    progress: '30%',
    provider: 'doubao',
    seconds: 5,
    status: 'processing',
    task_id: 'task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5',
    type: 'video',
    url: '',
    urls: []
};

const POLL_COMPLETED = {
    ...POLL_PENDING,
    completed_at: '2026-10-07T05:54:52Z',
    download_url: '/v1/tasks/task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5/download',
    download_urls: ['/v1/tasks/task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5/download'],
    progress: '100%',
    status: 'completed',
    url: '/v1/tasks/task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5/download',
    urls: ['/v1/tasks/task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5/download']
};

const DOWNLOAD_PATH = '/v1/tasks/task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5/download';
const DOWNLOAD_URL = `${channel.base_url}${DOWNLOAD_PATH}`;

const evaluate = async (expression, data) => JSON.parse(JSON.stringify(await jsonata(expression).evaluate(data)));

test('channel points at the AI 创作站点 with bearer auth and the supplied key', () => {
    assert.equal(channel.name, 'AI 创作');
    assert.equal(channel.base_url, 'http://116.211.150.21:3000');
    assert.equal(channel.auth_type, 'bearer');
    assert.match(channel.api_key, /^sk-/);
});

test('binding uses the documented routes, async flow and content proxy', () => {
    assert.equal(bindings.length, 1);
    const binding = bindings[0];
    assert.equal(binding.model_name, 'Seedance 2.0 Fast');
    assert.equal(binding.route_path, '/v1/videos/generations');
    assert.equal(binding.poll_path, '/v1/tasks/${up_task_id}');
    assert.equal(binding.is_async, 1);
    // 上游结果地址是站内相对路径且下载需要 Bearer，必须由网关代理取流。
    assert.equal(binding.proxy_content, 1);
    assert.equal(binding.poll_throttle, 1);
    assert.equal(binding.status, 1);
});

test('every mapping is a valid jsonata expression', async () => {
    for (const binding of bindings) {
        for (const field of ['req_mapping', 'resp_mapping', 'poll_mapping']) {
            assert.doesNotThrow(() => jsonata(binding[field]), `${field} failed to parse`);
        }
        await jsonata(binding.req_mapping).evaluate({ prompt: 'x' });
        await jsonata(binding.resp_mapping).evaluate(SUBMIT_RESPONSE);
        await jsonata(binding.poll_mapping).evaluate(POLL_PENDING);
    }
});

test('request mapping pins the upstream model and normalizes the optional fields', async () => {
    const binding = bindings[0];

    const minimal = await evaluate(binding.req_mapping, { prompt: 'ocean waves' });
    assert.deepEqual(minimal, {
        model: 'Seedance 2.0 Fast',
        prompt: 'ocean waves',
        seconds: 5,
        wait: false
    });

    // seconds 只支持 5 / 10 / 15：字符串与数字都接受，其余一律回落 5。
    for (const [input, expected] of [['5', 5], ['10', 10], ['15', 15], [5, 5], [10, 10], [15, 15]]) {
        const mapped = await evaluate(binding.req_mapping, { prompt: 'x', seconds: input });
        assert.equal(mapped.seconds, expected, `seconds=${JSON.stringify(input)}`);
        assert.equal(typeof mapped.seconds, 'number');
    }
    for (const input of ['7', 7, '0', 0, '-1', -1, '30', 60, 'abc', '', null, 5.5]) {
        const mapped = await evaluate(binding.req_mapping, { prompt: 'x', seconds: input });
        assert.equal(mapped.seconds, 5, `seconds=${JSON.stringify(input)} must fall back to 5`);
    }

    const full = await evaluate(binding.req_mapping, {
        prompt: '参考这些图片',
        seconds: '10',
        aspect_ratio: '9:16',
        resolution: '1080p',
        images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
        videos: ['https://example.com/motion.mp4'],
        audios: ['https://example.com/music.mp3']
    });
    assert.equal(full.aspect_ratio, '9:16');
    assert.deepEqual(full.image_urls, ['https://example.com/a.jpg', 'https://example.com/b.jpg']);
    // 上游没有 resolution 字段，也不支持参考视频/音频，这些字段不能出现在上游请求里。
    assert.equal('resolution' in full, false);
    assert.equal('videos' in full, false);
    assert.equal('audios' in full, false);
    assert.equal('video_urls' in full, false);
    assert.equal('audio_urls' in full, false);

    // 没有 aspect_ratio / images 时不发送这两个可选字段。
    const sparse = await evaluate(binding.req_mapping, { prompt: 'x', images: [] });
    assert.equal('aspect_ratio' in sparse, false);
    assert.equal('image_urls' in sparse, false);
    assert.equal(sparse.wait, false);
    assert.equal('request_id' in sparse, false);
});

test('submit response keeps the upstream task id', async () => {
    const binding = bindings[0];
    const mapped = await evaluate(binding.resp_mapping, SUBMIT_RESPONSE);
    assert.equal(mapped.task_id, 'task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5');
    assert.equal(mapped.id, 'task_jF9xYM3IxdgtUSSki5c0uqKq1IOXhMs5');
    assert.equal(mapped.status, 'pending');
    assert.equal(mapped.object, 'video.generation');
    assert.equal(mapped.model, 'Seedance 2.0 Fast');

    // 兼容把任务号放在 id 或 data.task_id 的上游变体。
    assert.equal((await evaluate(binding.resp_mapping, { id: 'task_up_2', status: 'pending' })).task_id, 'task_up_2');
    assert.equal((await evaluate(binding.resp_mapping, { data: { task_id: 'task_up_3' } })).task_id, 'task_up_3');
});

test('poll mapping normalizes status, progress and ISO timestamps', async () => {
    const binding = bindings[0];

    const pending = await evaluate(binding.poll_mapping, POLL_PENDING);
    assert.equal(pending.status, 'processing');
    assert.equal(pending.progress, 30);
    assert.equal(typeof pending.progress, 'number');
    // ISO 8601 -> Unix 秒
    assert.equal(pending.created_at, 1791352315);
    assert.equal(pending.video_url, '');
    assert.equal(pending.object, 'video.generation');
    assert.equal(pending.error, null);

    const queued = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'pending', progress: '10%' });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.progress, 10);

    // 上游未知状态不能透传，归一为 processing 继续轮询。
    const unknownState = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'weird', progress: '' });
    assert.equal(unknownState.status, 'processing');
    assert.equal(unknownState.progress, 0);
});

test('poll mapping turns the relative result path into an absolute upstream URL', async () => {
    const binding = bindings[0];
    const completed = await evaluate(binding.poll_mapping, POLL_COMPLETED);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, 100);
    assert.equal(completed.video_url, DOWNLOAD_URL);
    assert.equal(completed.object, DOWNLOAD_URL);
    assert.equal(completed.result_url, DOWNLOAD_URL);
    assert.equal(completed.created_at, 1791352315);
    assert.equal(completed.completed_at, 1791352492);
    assert.equal(completed.error, null);

    // 只有 urls[] / download_url / download_urls[] 时也要能取到结果。
    const urlsOnly = await evaluate(binding.poll_mapping, { ...POLL_COMPLETED, url: '', download_url: undefined, download_urls: undefined });
    assert.equal(urlsOnly.video_url, DOWNLOAD_URL);
    const downloadOnly = await evaluate(binding.poll_mapping, { ...POLL_COMPLETED, url: '', urls: [], download_urls: undefined });
    assert.equal(downloadOnly.video_url, DOWNLOAD_URL);
    const downloadListOnly = await evaluate(binding.poll_mapping, { ...POLL_COMPLETED, url: '', urls: [], download_url: undefined });
    assert.equal(downloadListOnly.video_url, DOWNLOAD_URL);
});

test('completed tasks prefer the stable station download endpoint over a third-party CDN link', async () => {
    const binding = bindings[0];
    // 上游对已完成任务可能返回带签名的第三方 CDN 直链，它实测出现过 403 Forbidden；
    // 网关取流必须改用上游自己的 /v1/tasks/{task_id}/download（同源，代理时会带渠道密钥）。
    const cdn = 'https://v3-videoweb.doubao.com/eb71ab/video/tos/cn/xxx/?a=497858&mime_type=video_mp4&l=2026';
    const completed = await evaluate(binding.poll_mapping, {
        ...POLL_COMPLETED,
        url: cdn,
        urls: [cdn],
        download_url: DOWNLOAD_PATH,
        download_urls: [DOWNLOAD_PATH]
    });
    assert.equal(completed.video_url, DOWNLOAD_URL);
    assert.equal(completed.object, DOWNLOAD_URL);
    assert.equal(completed.result_url, DOWNLOAD_URL);
    // 上游原始直链仍然留档，便于排查 CDN 侧问题。
    assert.equal(completed.upstream_result_url, cdn);

    // 没有 task_id 时就只能退回上游给的地址（本站相对路径拼 base_url，绝对地址原样）。
    const noTaskId = await evaluate(binding.poll_mapping, { ...POLL_COMPLETED, task_id: undefined, url: cdn, urls: [cdn] });
    assert.equal(noTaskId.video_url, cdn);
    const noTaskIdRelative = await evaluate(binding.poll_mapping, { ...POLL_COMPLETED, task_id: '', url: DOWNLOAD_PATH, urls: [] });
    assert.equal(noTaskIdRelative.video_url, DOWNLOAD_URL);
});

test('poll mapping always produces a terminal state for upstream failures', async () => {
    const binding = bindings[0];

    const failed = await evaluate(binding.poll_mapping, {
        ...POLL_PENDING,
        status: 'failed',
        progress: '100%',
        error: 'reference image unreachable',
        error_code: 'reference_not_found',
        completed_at: '2026-10-07T05:53:00Z'
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'reference image unreachable');
    assert.equal(failed.error_code, 'reference_not_found');
    assert.equal(failed.video_url, '');
    assert.equal(failed.completed_at, 1791352380);

    // 上游把错误写进 error 却把 status 留在进行中：必须落成 failed，否则下游会一直轮询。
    const errorWhileRunning = await evaluate(binding.poll_mapping, { ...POLL_PENDING, error: 'provider 内部错误' });
    assert.equal(errorWhileRunning.status, 'failed');
    assert.equal(errorWhileRunning.error, 'provider 内部错误');
    assert.equal(errorWhileRunning.video_url, '');

    // 只有 display_error_message 时用它作为错误正文。
    const displayError = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'failed', display_error_message: '参考图下载失败' });
    assert.equal(displayError.status, 'failed');
    assert.equal(displayError.error, '参考图下载失败');

    // 没有 status / 没有 data 包装 / 错误体：不能输出空状态，必须有可读 error。
    const errorBody = await evaluate(binding.poll_mapping, { code: 500, msg: 'internal error', status: 'failed' });
    assert.equal(errorBody.status, 'failed');
    assert.equal(errorBody.error, '上游任务失败: failed');
    assert.equal(typeof errorBody.created_at, 'number');
    assert.ok(Math.abs(errorBody.created_at - Math.floor(Date.now() / 1000)) <= 5);

    const noStatus = await evaluate(binding.poll_mapping, {});
    assert.equal(noStatus.status, 'processing');
    assert.equal(noStatus.progress, 0);
    assert.equal(typeof noStatus.created_at, 'number');
    assert.equal(noStatus.error, null);
});

test('model remark documents the supported durations, aspect ratios and reference limit', () => {
    const remark = models[0].remark;
    for (const token of ['5 / 10 / 15', 'image_urls', '10 张', '不支持参考视频与参考音频', 'Bearer']) {
        assert.ok(remark.includes(token), `remark must mention ${token}`);
    }
});
