const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { channel, bindings, model } = require('../scripts/snumom-wan3-image-prime-config');

const binding = bindings[0];
const plain = value => JSON.parse(JSON.stringify(value));

async function mapRequest(body) {
    return plain(await jsonata(binding.req_mapping).evaluate({ model: model.model_name, ...body }));
}

async function mapResponse(body) {
    return plain(await jsonata(binding.resp_mapping).evaluate(body));
}

async function mapPoll(body) {
    return plain(await jsonata(binding.poll_mapping).evaluate(body));
}

test('binding targets snumom /v1/videos with async polling and gateway proxying', () => {
    assert.equal(channel.base_url, 'https://snumom.com');
    assert.equal(channel.auth_type, 'bearer');
    assert.equal(binding.model_name, 'wan3.0-image-prime');
    assert.equal(binding.route_path, '/v1/videos');
    assert.equal(binding.poll_path, '/v1/videos/${up_task_id}');
    assert.equal(binding.is_async, 1);
    // 上游 metadata.url 24 小时后失效，成品走网关代理更稳。
    assert.equal(binding.proxy_content, 1);
    assert.equal(binding.poll_mapping.length > 0, true);
});

test('seconds maps to seconds with the documented 2-30 range and 5 second fallback', async () => {
    // 上游 seconds 的 Go 字段是 string：这里必须发字符串，否则上游报
    // invalid_json / cannot unmarshal number into Go struct field .Alias.seconds of type string
    for (const [input, expected] of [
        ['10', '10'], [10, '10'], ['2', '2'], [30, '30'], ['5', '5'],
        [undefined, '5'], ['', '5'], [-1, '5'], [0, '5'], [1, '5'], [31, '5'], ['abc', '5']
    ]) {
        const mapped = await mapRequest({ prompt: '图1人物自然转头', seconds: input, size: '480P' });
        assert.equal(mapped.seconds, expected, `seconds=${input}`);
        assert.equal(typeof mapped.seconds, 'string', `seconds=${input} must be sent as a string`);
        assert.equal(mapped.model, 'wan3.0-image-prime');
        assert.equal(mapped.prompt, '图1人物自然转头');
    }
});

test('resolution maps to upstream size and defaults to 1080P when missing or invalid', async () => {
    for (const [resolution, expected] of [
        ['480P', '480P'], ['720P', '720P'], ['1080P', '1080P'],
        [undefined, '1080P'], ['', '1080P'], ['2K', '1080P'], ['720p', '1080P']
    ]) {
        const mapped = await mapRequest({ prompt: 'a', seconds: 5, resolution });
        assert.equal(mapped.size, expected, `resolution=${resolution}`);
    }
});

test('aspect ratio defaults to adaptive for first frame usage', async () => {
    assert.equal((await mapRequest({ prompt: 'a', seconds: 5, aspect_ratio: '16:9' })).aspect_ratio, '16:9');
    assert.equal((await mapRequest({ prompt: 'a', seconds: 5, aspect_ratio: 'adaptive' })).aspect_ratio, 'adaptive');
    assert.equal((await mapRequest({ prompt: 'a', seconds: 5 })).aspect_ratio, 'adaptive');
    assert.equal((await mapRequest({ prompt: 'a', seconds: 5, aspect_ratio: '' })).aspect_ratio, 'adaptive');
});

test('plain image URLs become reference_image entries and role objects survive', async () => {
    const strings = await mapRequest({ prompt: 'a', seconds: 10, images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] });
    assert.deepEqual(strings.reference_images, [
        { url: 'https://example.com/a.jpg', role: 'reference_image' },
        { url: 'https://example.com/b.jpg', role: 'reference_image' }
    ]);
    assert.equal(Object.hasOwn(strings, 'reference_videos'), false);
    assert.equal(Object.hasOwn(strings, 'videos'), false);

    const firstFrame = await mapRequest({
        prompt: 'a',
        seconds: 10,
        images: [{ url: 'https://example.com/start.jpg', role: 'first_frame' }, { url: 'https://example.com/end.jpg', role: 'last_frame' }]
    });
    assert.deepEqual(firstFrame.reference_images, [
        { url: 'https://example.com/start.jpg', role: 'first_frame' },
        { url: 'https://example.com/end.jpg', role: 'last_frame' }
    ]);

    const audios = await mapRequest({ prompt: 'a', seconds: 10, audios: ['https://example.com/voice.mp3'] });
    assert.deepEqual(audios.reference_audios, [{ url: 'https://example.com/voice.mp3', role: 'reference_image' }]);
});

test('reference media fields are omitted when the caller sends nothing', async () => {
    for (const body of [{}, { images: [] }, { audios: [] }, { images: [], audios: [] }]) {
        const mapped = await mapRequest({ prompt: 'a', seconds: 10, ...body });
        assert.deepEqual(Object.keys(mapped).sort(), ['aspect_ratio', 'model', 'prompt', 'seconds', 'size']);
    }
});

test('prompt_extend and input.media pass through, videos never do', async () => {
    assert.equal(Object.hasOwn(await mapRequest({ prompt: 'a', seconds: 5 }), 'parameters'), false);
    assert.deepEqual((await mapRequest({ prompt: 'a', seconds: 5, prompt_extend: false })).parameters, { prompt_extend: false });
    assert.deepEqual((await mapRequest({ prompt: 'a', seconds: 5, parameters: { prompt_extend: true, watermark: false } })).parameters, {
        prompt_extend: true, watermark: false
    });
    const withMedia = await mapRequest({
        prompt: 'a',
        seconds: 5,
        input: { media: [{ type: 'file', url: 'https://cdn.example.com/product.pptx' }] },
        videos: ['https://example.com/motion.mp4']
    });
    assert.deepEqual(withMedia.input, { media: [{ type: 'file', url: 'https://cdn.example.com/product.pptx' }] });
    assert.equal(Object.hasOwn(withMedia, 'reference_videos'), false);
});

test('create response keeps the upstream task id', async () => {
    assert.deepEqual(await mapResponse({ id: 'task_xxx', object: 'video', status: 'queued' }), {
        task_id: 'task_xxx',
        id: 'task_xxx',
        status: 'queued',
        progress: 0,
        object: 'video',
        model: 'wan3.0-image-prime'
    });
});

test('poll mapping normalizes statuses and lifts metadata.url to video_url', async () => {
    const completed = await mapPoll({
        id: 'task_xxx',
        status: 'completed',
        progress: 100,
        metadata: { url: 'https://cdn.snumom.com/out.mp4' },
        seconds: 10,
        size: '480P'
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.video_url, 'https://cdn.snumom.com/out.mp4');
    assert.equal(completed.object, 'https://cdn.snumom.com/out.mp4');
    assert.equal(completed.progress, 100);
    assert.equal(completed.error, null);

    const processing = await mapPoll({ id: 'task_xxx', status: 'in_progress', progress: 30 });
    assert.equal(processing.status, 'processing');
    assert.equal(processing.progress, 30);
    assert.equal(processing.video_url, '');

    for (const status of ['queued', 'not_start', 'pending']) {
        assert.equal((await mapPoll({ status })).status, 'queued', status);
    }

    const failed = await mapPoll({ status: 'failed', message: '内容审核未通过' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, '内容审核未通过');
    assert.equal(failed.video_url, '');

    const failedWithoutMessage = await mapPoll({ status: 'failed' });
    assert.equal(failedWithoutMessage.error, '上游任务失败: failed');

    const noStatus = await mapPoll({ id: 'task_xxx' });
    assert.equal(noStatus.status, 'processing');
    assert.equal(noStatus.video_url, '');

    const topLevelUrl = await mapPoll({ status: 'completed', url: 'https://cdn.snumom.com/top.mp4' });
    assert.equal(topLevelUrl.video_url, 'https://cdn.snumom.com/top.mp4');
});

test('poll mapping always returns created_at as a unix timestamp', async () => {
    const mapped = await mapPoll({ status: 'queued' });
    assert.equal(Number.isInteger(mapped.created_at) && mapped.created_at > 1600000000, true);
});
