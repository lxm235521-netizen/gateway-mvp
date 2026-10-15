// 校验 MINIMAXH3（openaivideo.top）三个采样档位的渠道与映射。
// 只跑本地表达式与模拟响应，不发起任何付费生成请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { BASE_URL, RATIOS, channel, models, bindings } = require('../scripts/minimaxh3-openaivideo-config');

const TIER_101010 = 'MINIMAX-H3-2.5采样-101010';
const TIER_301010 = 'MINIMAX-H3-2.5采样-301010';
const TIER_933 = 'MINIMAX-H3-2.0采样-933';

const byModel = Object.fromEntries(bindings.map(binding => [binding.model_name, binding]));

const evaluate = async (expression, data) => JSON.parse(JSON.stringify(await jsonata(expression).evaluate(data)));

const UP_TASK_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const DOWNLOAD_URL = `${BASE_URL}/v1/tasks/${UP_TASK_ID}/download?index=0`;

const SUBMIT_RESPONSE = {
    task_id: UP_TASK_ID,
    id: UP_TASK_ID,
    status: 'pending',
    model: TIER_101010,
    created_at: '2026-11-20T12:00:00.000Z'
};

const POLL_PENDING = {
    task_id: UP_TASK_ID,
    status: 'pending',
    model: TIER_101010,
    task_type: 'video',
    progress_pct: 0,
    progress_text: '排队中',
    result_urls: [],
    source_urls: [],
    created_at: '2026-11-20T12:00:00.000Z'
};

test('channel points at openaivideo.top with bearer auth and the supplied key', () => {
    assert.equal(channel.name, 'MINIMAXH3 视频');
    assert.equal(channel.base_url, 'https://openaivideo.top');
    assert.equal(channel.auth_type, 'bearer');
    assert.match(channel.api_key, /^jm-/);
    // 下游 data URL 参考图要先换图床链接；取流失败时回退站内下载接口。
    assert.equal(channel.convert_base64_to_url, 1);
    assert.equal(channel.content_fallback_enabled, 1);
});

test('the three requested tiers are configured with the documented caps', () => {
    assert.deepEqual(models.map(model => model.model_name).sort(), [TIER_101010, TIER_301010, TIER_933].sort());
    assert.deepEqual(bindings.map(binding => binding.model_name), [TIER_101010, TIER_301010, TIER_933]);

    for (const binding of bindings) {
        assert.equal(binding.route_path, '/v1/videos/generations');
        assert.equal(binding.poll_path, '/v1/tasks/${up_task_id}');
        assert.equal(binding.is_async, 1);
        // 结果走站内下载接口（需要 Bearer、支持 Range），必须由网关代理取流。
        assert.equal(binding.proxy_content, 1);
        assert.equal(binding.poll_throttle, 1);
        assert.equal(binding.error_passthrough, 1);
        assert.equal(binding.status, 1);
    }
});

test('every mapping is a valid jsonata expression', async () => {
    for (const binding of bindings) {
        for (const field of ['req_mapping', 'resp_mapping', 'poll_mapping']) {
            assert.doesNotThrow(() => jsonata(binding[field]), `${binding.model_name}.${field} failed to parse`);
        }
        await jsonata(binding.req_mapping).evaluate({ prompt: 'x' });
        await jsonata(binding.resp_mapping).evaluate(SUBMIT_RESPONSE);
        await jsonata(binding.poll_mapping).evaluate(POLL_PENDING);
    }
});

test('request mapping pins the upstream model id and only sends supported fields', async () => {
    const binding = byModel[TIER_101010];

    const minimal = await evaluate(binding.req_mapping, { prompt: '海边日落，镜头缓慢前推' });
    assert.deepEqual(minimal, {
        model: TIER_101010,
        prompt: '海边日落，镜头缓慢前推',
        // 没有素材时走上游的文生视频路径。
        function_mode: 'first_last_frames',
        ratio: '16:9',
        duration: 5,
        video_resolution: '720p'
    });
    // 下游字段不会原样出现在上游请求里。
    for (const key of ['seconds', 'aspect_ratio', 'resolution', 'images', 'videos', 'audios', 'channel']) {
        assert.equal(key in minimal, false, `${key} must not be forwarded`);
    }

    const full = await evaluate(binding.req_mapping, {
        prompt: '参考这些素材',
        seconds: '20',
        aspect_ratio: '9:16',
        resolution: '1080p',
        images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
        videos: ['https://example.com/motion.mp4'],
        audios: ['https://example.com/music.mp3']
    });
    assert.equal(full.function_mode, 'omni_reference');
    assert.equal(full.ratio, '9:16');
    assert.equal(full.duration, 20);
    // 上游只有 720p，下游传 1080p 也不会改变它。
    assert.equal(full.video_resolution, '720p');
    assert.deepEqual(full.materials, [
        { type: 'image', url: 'https://example.com/a.jpg', name: 'image_file_1' },
        { type: 'image', url: 'https://example.com/b.jpg', name: 'image_file_2' },
        { type: 'video', url: 'https://example.com/motion.mp4', name: 'video_file_1' },
        { type: 'audio', url: 'https://example.com/music.mp3', name: 'audio_file_1' }
    ]);
});

test('素材项接受 {url} 对象、单个标量，并丢掉空值', async () => {
    const binding = byModel[TIER_101010];

    const objects = await evaluate(binding.req_mapping, {
        prompt: 'x',
        images: [{ url: 'https://example.com/a.jpg' }, { url: '' }, null, '', 'https://example.com/b.jpg']
    });
    assert.deepEqual(objects.materials, [
        { type: 'image', url: 'https://example.com/a.jpg', name: 'image_file_1' },
        { type: 'image', url: 'https://example.com/b.jpg', name: 'image_file_2' }
    ]);

    // 下游只传一个字符串时也要变成 materials 数组（不是对象）。
    const single = await evaluate(binding.req_mapping, { prompt: 'x', images: 'https://example.com/only.jpg' });
    assert.ok(Array.isArray(single.materials));
    assert.deepEqual(single.materials, [{ type: 'image', url: 'https://example.com/only.jpg', name: 'image_file_1' }]);

    // 空数组 / null / 非字符串对象都不产生 materials。
    for (const value of [[], null, {}, 0, [null, '']]) {
        const mapped = await evaluate(binding.req_mapping, { prompt: 'x', images: value });
        assert.equal('materials' in mapped, false, `images=${JSON.stringify(value)} must not create materials`);
    }
});

test('素材数量按各档上限截断，并且 @imgN / @vidN / @audN 会改写成上游素材名', async () => {
    const images = Array.from({ length: 12 }, (unused, index) => `https://example.com/i${index + 1}.jpg`);

    const tier101010 = await evaluate(byModel[TIER_101010].req_mapping, { prompt: '@img1 和 @img2', images });
    assert.equal(tier101010.materials.length, 10);
    assert.equal(tier101010.materials[9].name, 'image_file_10');
    assert.equal(tier101010.prompt, '@image_file_1 和 @image_file_2');

    const tier301010 = await evaluate(byModel[TIER_301010].req_mapping, { prompt: 'x', images });
    assert.equal(tier301010.materials.length, 12);

    const tier301010Capped = await evaluate(byModel[TIER_301010].req_mapping, {
        prompt: 'x',
        images: Array.from({ length: 35 }, (unused, index) => `https://example.com/i${index + 1}.jpg`)
    });
    assert.equal(tier301010Capped.materials.length, 30);
    assert.equal(tier301010Capped.materials[29].name, 'image_file_30');

    const tier933 = await evaluate(byModel[TIER_933].req_mapping, {
        prompt: '@vid1 和 @aud1 和 @vid2',
        images,
        videos: ['https://example.com/v1.mp4', 'https://example.com/v2.mp4', 'https://example.com/v3.mp4', 'https://example.com/v4.mp4'],
        audios: ['https://example.com/a1.mp3', 'https://example.com/a2.mp3', 'https://example.com/a3.mp3', 'https://example.com/a4.mp3']
    });
    assert.equal(tier933.materials.filter(item => item.type === 'image').length, 9);
    assert.equal(tier933.materials.filter(item => item.type === 'video').length, 3);
    assert.equal(tier933.materials.filter(item => item.type === 'audio').length, 3);
    assert.equal(tier933.prompt, '@video_file_1 和 @audio_file_1 和 @video_file_2');
    // 933 没有 first_last_frames，纯提示词也要走 omni_reference。
    const textOnly = await evaluate(byModel[TIER_933].req_mapping, { prompt: '只有提示词' });
    assert.equal(textOnly.function_mode, 'omni_reference');
    assert.equal('materials' in textOnly, false);
});

test('seconds / aspect_ratio 归一化：越界与非法值回落，白名单外的画幅回落 16:9', async () => {
    const tier101010 = byModel[TIER_101010];
    const tier933 = byModel[TIER_933];

    for (const [input, expected] of [[4, 4], ['5', 5], [30, 30], ['30', 30], ['10', 10]]) {
        const mapped = await evaluate(tier101010.req_mapping, { prompt: 'x', seconds: input });
        assert.equal(mapped.duration, expected, `seconds=${JSON.stringify(input)}`);
        assert.equal(typeof mapped.duration, 'number');
    }
    for (const input of [0, 3, 31, 100, -1, 5.5, 'abc', '', null, [], {}]) {
        const mapped = await evaluate(tier101010.req_mapping, { prompt: 'x', seconds: input });
        assert.equal(mapped.duration, 5, `seconds=${JSON.stringify(input)} must fall back to 5`);
    }
    // 933 的上限是 15：16 秒回落 5，15 秒保留。
    assert.equal((await evaluate(tier933.req_mapping, { prompt: 'x', seconds: 15 })).duration, 15);
    assert.equal((await evaluate(tier933.req_mapping, { prompt: 'x', seconds: 16 })).duration, 5);

    for (const ratio of RATIOS) {
        const mapped = await evaluate(tier101010.req_mapping, { prompt: 'x', aspect_ratio: ratio });
        assert.equal(mapped.ratio, ratio);
    }
    for (const ratio of ['adaptive', '4:5', '16x9', '', null, 16]) {
        const mapped = await evaluate(tier101010.req_mapping, { prompt: 'x', aspect_ratio: ratio });
        assert.equal(mapped.ratio, '16:9', `aspect_ratio=${JSON.stringify(ratio)} must fall back to 16:9`);
    }
});

test('submit response keeps the upstream task id', async () => {
    const binding = byModel[TIER_101010];
    const mapped = await evaluate(binding.resp_mapping, SUBMIT_RESPONSE);
    assert.equal(mapped.task_id, UP_TASK_ID);
    assert.equal(mapped.id, UP_TASK_ID);
    assert.equal(mapped.status, 'pending');
    assert.equal(mapped.object, 'video');
    assert.equal(mapped.model, TIER_101010);

    // 兼容把任务号放在 id 或 data.task_id 的上游变体。
    assert.equal((await evaluate(binding.resp_mapping, { id: 'up-2', status: 'pending' })).task_id, 'up-2');
    assert.equal((await evaluate(binding.resp_mapping, { data: { task_id: 'up-3' } })).task_id, 'up-3');
    assert.equal((await evaluate(binding.resp_mapping, { status: 'pending' })).status, 'pending');
});

test('poll mapping normalizes the upstream states into the gateway contract', async () => {
    const binding = byModel[TIER_101010];

    for (const [upstream, expected] of [
        ['pending', 'queued'],
        ['submitted', 'queued'],
        ['generating', 'processing'],
        ['post_processing', 'processing'],
        ['finalizing', 'processing'],
        ['something-new', 'processing'],
        ['success', 'completed']
    ]) {
        const mapped = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: upstream, progress_pct: 40 });
        assert.equal(mapped.status, expected, `status=${upstream}`);
        if (expected !== 'completed') {
            assert.equal(mapped.progress, 40);
            assert.equal(mapped.video_url, '');
            assert.equal(mapped.error, null);
        }
    }

    const running = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'generating', progress_pct: 30 });
    assert.equal(running.object, 'video.generation');
    assert.equal(running.created_at, 1795176000);
    assert.equal(running.completed_at, null);
    assert.equal(running.progress_text, '排队中');

    // 进度可能是字符串，缺字段时按 0 处理。
    assert.equal((await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'generating', progress_pct: '55' })).progress, 55);
    assert.equal((await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'generating', progress_pct: undefined })).progress, 0);
});

test('poll mapping points completed tasks at the station download endpoint', async () => {
    const binding = byModel[TIER_101010];

    const completed = await evaluate(binding.poll_mapping, {
        ...POLL_PENDING,
        status: 'success',
        progress_pct: 100,
        progress_text: '生成完成',
        // 上游预览与高清链接都可能是会过期的 CDN 直链。
        result_urls: ['https://cdn.example.com/play.mp4'],
        source_urls: ['https://cdn.example.com/origin.mp4?download=true'],
        completed_at: '2026-11-20T12:34:56.000Z'
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, 100);
    assert.equal(completed.video_url, DOWNLOAD_URL);
    assert.equal(completed.object, DOWNLOAD_URL);
    assert.equal(completed.result_url, DOWNLOAD_URL);
    assert.equal(completed.upstream_result_url, 'https://cdn.example.com/origin.mp4?download=true');
    assert.equal(completed.completed_at, 1795178096);
    assert.equal(completed.error, null);

    // 没有 task_id 时退回上游直链；只有预览链接时也能取到。
    const noTaskId = await evaluate(binding.poll_mapping, {
        ...POLL_PENDING,
        status: 'success',
        task_id: undefined,
        result_urls: ['https://cdn.example.com/play.mp4'],
        source_urls: []
    });
    assert.equal(noTaskId.video_url, 'https://cdn.example.com/play.mp4');
});

test('poll mapping always produces a terminal state with a readable error', async () => {
    const binding = byModel[TIER_101010];

    const failed = await evaluate(binding.poll_mapping, {
        ...POLL_PENDING,
        status: 'failed',
        progress_pct: 100,
        fail_reason: '参考图含未认证人脸，暂不支持生成。请换其它参考图，或改用文生视频。',
        completed_at: '2026-11-20T12:10:00.000Z'
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.progress, 100);
    assert.equal(failed.video_url, '');
    assert.equal(failed.error, '参考图含未认证人脸，暂不支持生成。请换其它参考图，或改用文生视频。');
    assert.equal(typeof failed.completed_at, 'number');

    // 上游把错误写在 error / error_message 里但状态仍是进行中：必须落成 failed。
    const errorWhileRunning = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'generating', error: '素材上传失败，请重试' });
    assert.equal(errorWhileRunning.status, 'failed');
    assert.equal(errorWhileRunning.error, '素材上传失败，请重试');
    const messageWhileRunning = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'generating', error_message: '服务繁忙，请稍后重试' });
    assert.equal(messageWhileRunning.status, 'failed');
    assert.equal(messageWhileRunning.error, '服务繁忙，请稍后重试');

    // 失败但没有可读原因时也要给出兜底文案，避免下游拿到空错误。
    const silentFailure = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'failed', progress_pct: 100 });
    assert.equal(silentFailure.status, 'failed');
    assert.equal(silentFailure.error, '上游任务失败: failed');

    // 完全没有状态 / 空响应：不能输出空状态，继续按 processing 轮询。
    const noStatus = await evaluate(binding.poll_mapping, {});
    assert.equal(noStatus.status, 'processing');
    assert.equal(noStatus.progress, 0);
    assert.equal(noStatus.video_url, '');
    assert.equal(typeof noStatus.created_at, 'number');
    assert.equal(noStatus.error, null);

    // 提交响应里的提示性 message 不能当成失败（上游 202 会带 "Task is still running; poll ..."）。
    const informational = await evaluate(binding.poll_mapping, { ...POLL_PENDING, status: 'generating', message: 'Task is still running; poll /v1/tasks/xxx.' });
    assert.equal(informational.status, 'processing');
    assert.equal(informational.error, null);
});

test('每个模型的 remark 记录了档位上限与上游事实', () => {
    const remark101010 = models[0].remark;
    for (const token of ['101010', '4~30', '720p', 'omni_reference', 'image_file_N']) {
        assert.ok(remark101010.includes(token), `remark must mention ${token}`);
    }
    assert.ok(models[1].remark.includes('30'));
    const remark933 = models[2].remark;
    for (const token of ['933', '4~15', '不支持 first_last_frames']) {
        assert.ok(remark933.includes(token), `933 remark must mention ${token}`);
    }
});
