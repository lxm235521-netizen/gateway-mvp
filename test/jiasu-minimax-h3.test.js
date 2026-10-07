const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { channel, channels, models, bindings, MODEL_NAME } = require('../scripts/jiasu-minimax-h3-config');

const binding = bindings[0];
const reqMapping = jsonata(binding.req_mapping);
const respMapping = jsonata(binding.resp_mapping);
const pollMapping = jsonata(binding.poll_mapping);
const plain = value => JSON.parse(JSON.stringify(value));

test('渠道与绑定指向佳速、异步视频、复用既有渠道', () => {
    assert.equal(channels.length, 1);
    assert.equal(channel.name, '佳速 Seedance');
    assert.equal(channel.base_url, 'https://ai.jiasuapi.com/v1');
    assert.equal(channel.auth_type, 'bearer');
    assert.match(channel.api_key, /^sk-/);

    assert.equal(bindings.length, 1);
    assert.equal(binding.model_name, 'minimax-h3-2k');
    assert.equal(binding.route_path, '/video/generations');
    assert.equal(binding.poll_path, '/videos/tasks/${up_task_id}');
    assert.equal(binding.is_async, 1);
    assert.equal(binding.status, 1);
    assert.equal(binding.proxy_content, 1);
});

test('上游模型名固定为 minimax-h3，逻辑模型名与上游名解耦', () => {
    assert.equal(MODEL_NAME, 'minimax-h3');
    assert.equal(models[0].upstream_model_name, 'minimax-h3');
    assert.equal(models[0].model_name, 'minimax-h3-2k');
    // 旧逻辑模型名保留在 legacy 列表里，供配置脚本改名复用而不是新建重复记录
    assert.deepEqual(models[0].legacy_model_names, ['minimax-h3-933-2k-支持真人']);
});

test('请求映射发出的上游 model 是 minimax-h3，不是下游逻辑模型名', async () => {
    const mapped = plain(await reqMapping.evaluate({ model: 'minimax-h3-2k', prompt: 'x' }));
    assert.equal(mapped.model, 'minimax-h3');
});

test('请求映射：model/prompt 必填，resolution 固定 2k，ratio 缺省 16:9', async () => {
    const mapped = plain(await reqMapping.evaluate({ model: 'minimax-h3-2k', prompt: '参考视频动作' }));
    assert.deepEqual(mapped, {
        model: MODEL_NAME,
        prompt: '参考视频动作',
        resolution: '2k',
        ratio: '16:9'
    });
});

test('请求映射：seconds 只在 1–15 时映射 duration，其它值一概不发', async () => {
    const withSeconds = async seconds => plain(await reqMapping.evaluate({ prompt: 'x', seconds }));

    assert.equal((await withSeconds('15')).duration, 15);
    assert.equal((await withSeconds(15)).duration, 15);
    assert.equal((await withSeconds('1')).duration, 1);
    assert.equal((await withSeconds('7')).duration, 7);

    for (const seconds of [undefined, null, '', 0, '-1', 16, 100, 'abc']) {
        const mapped = await withSeconds(seconds);
        assert.equal('duration' in mapped, false, `seconds=${JSON.stringify(seconds)} 不应带 duration`);
    }
});

test('请求映射：aspect_ratio 透传，参考图最多原样传给上游', async () => {
    const mapped = plain(await reqMapping.evaluate({
        prompt: 'x', aspect_ratio: '9:16', images: ['https://a.example/1.png', { url: 'https://a.example/2.png' }]
    }));
    assert.equal(mapped.ratio, '9:16');
    assert.deepEqual(mapped.images, ['https://a.example/1.png', { url: 'https://a.example/2.png' }]);
});

test('请求映射：参考视频要求对象带 duration_seconds，网关原样透传', async () => {
    const videos = [
        { url: 'https://m.jiasuapi.com/media/a.mp4', duration_seconds: 6 },
        { url: 'https://m.jiasuapi.com/media/b.mp4', duration_seconds: 5, mime: 'video/mp4' }
    ];
    const mapped = plain(await reqMapping.evaluate({ prompt: 'x', videos }));
    assert.deepEqual(mapped.videos, videos);
    // 每条都带 duration_seconds，符合上游「专用格式」要求
    assert.ok(mapped.videos.every(item => typeof item.duration_seconds === 'number'));
});

test('请求映射：不支持时省略参考媒资字段，不发送空数组', async () => {
    const mapped = plain(await reqMapping.evaluate({ prompt: 'x' }));
    for (const key of ['images', 'videos', 'audios']) {
        assert.equal(key in mapped, false, key);
    }
    assert.deepEqual(Object.keys(mapped).sort(), ['model', 'prompt', 'ratio', 'resolution']);
});

test('请求映射：参考音频与图/视频一起透传', async () => {
    const mapped = plain(await reqMapping.evaluate({
        prompt: 'x',
        images: ['https://a.example/1.png'],
        videos: [{ url: 'https://m.jiasuapi.com/media/a.mp4', duration_seconds: 6 }],
        audios: [{ url: 'https://m.jiasuapi.com/media/a.mp3', mime: 'audio/mpeg' }]
    }));
    assert.equal(mapped.images.length, 1);
    assert.equal(mapped.videos.length, 1);
    assert.equal(mapped.audios.length, 1);
});

test('提交响应映射出 task_id，兼容 task_id/id', async () => {
    const fromId = plain(await respMapping.evaluate({
        id: 'task_IFddsYNnIXkEJPI1rjTcknAxwhXGyzcX', object: 'video', model: 'minimax-h3',
        status: 'queued', progress: 0, created_at: 1791082196
    }));
    assert.equal(fromId.task_id, 'task_IFddsYNnIXkEJPI1rjTcknAxwhXGyzcX');
    assert.equal(fromId.status, 'queued');
    assert.equal(fromId.progress, 0);
    assert.equal(fromId.object, 'video');

    const fromTaskId = plain(await respMapping.evaluate({ task_id: 'task_abc' }));
    assert.equal(fromTaskId.task_id, 'task_abc');
    assert.equal(fromTaskId.id, 'task_abc');
    assert.equal(fromTaskId.status, 'queued');
});

test('轮询映射：状态归一、完成取 result_urls[0]、失败带 error.message', async () => {
    const completed = plain(await pollMapping.evaluate({
        status: 'completed', progress: 100, result_urls: ['https://m.jiasuapi.com/media/out.mp4'], created_at: 1, completed_at: 2
    }));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, 100);
    assert.equal(completed.video_url, 'https://m.jiasuapi.com/media/out.mp4');
    assert.equal(completed.result_url, 'https://m.jiasuapi.com/media/out.mp4');
    assert.equal(completed.object, 'https://m.jiasuapi.com/media/out.mp4');

    const running = plain(await pollMapping.evaluate({ status: 'in_progress', progress: 30 }));
    assert.equal(running.status, 'processing');
    assert.equal(running.video_url, '');

    for (const status of ['queued', 'unknown', 'pending']) {
        assert.equal((await pollMapping.evaluate({ status })).status, 'queued', status);
    }

    const failed = plain(await pollMapping.evaluate({ status: 'failed', error: { message: '内容审核未通过', code: 'bad_request' } }));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, '内容审核未通过');
    assert.equal(failed.video_url, '');
});

test('轮询映射：status 缺失或错误体也要落到终态，不能没有 status', async () => {
    // 上游返回 error 而没有 status
    const errored = plain(await pollMapping.evaluate({ error: { message: '模型超时' } }));
    assert.ok(errored.status, 'status 必须有值');
    assert.equal(errored.status, 'processing');
    assert.equal(errored.error, '模型超时');

    // 完全没有 status 的正常体：归一为处理中，避免下游拿到无状态响应
    const missing = plain(await pollMapping.evaluate({ progress: 10 }));
    assert.equal(missing.status, 'processing');

    // created_at 缺失时补当前秒级时间戳
    assert.ok(Number.isInteger(missing.created_at) && missing.created_at > 1000000000);
});
