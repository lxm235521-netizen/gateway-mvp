const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { channel, bindings } = require('../scripts/jiasu-seedance-config');
const plain = value => JSON.parse(JSON.stringify(value));

test('channel targets the jiasu video API with bearer auth', () => {
    assert.equal(channel.base_url, 'https://ai.jiasuapi.com/v1');
    assert.equal(channel.auth_type, 'bearer');
    for (const binding of bindings) {
        assert.equal(binding.route_path, '/video/generations');
        assert.equal(binding.poll_path, '/videos/tasks/${up_task_id}');
        assert.equal(binding.is_async, 1);
        assert.equal(binding.proxy_content, 0);
    }
});

test('request mapping pins the upstream model and applies documented defaults', async () => {
    for (const binding of bindings) {
        const request = jsonata(binding.req_mapping);
        const minimal = await request.evaluate({ prompt: 'test' });
        assert.equal(minimal.model, binding.model_name);
        assert.equal(minimal.prompt, 'test');
        assert.equal(minimal.ratio, '16:9');
        assert.equal(minimal.resolution, '720p');
        // The upstream bills per second on its own default when duration is omitted.
        assert.equal('duration' in minimal, false);
        assert.equal('images' in minimal, false);

        const full = await request.evaluate({
            prompt: '@角色1在@场景1中说话',
            seconds: '5',
            aspect_ratio: '9:16',
            resolution: '1080p',
            images: ['https://example.com/char1.png', { url: 'https://example.com/scene1.png', name: '场景1' }],
            videos: ['https://example.com/motion.mp4'],
            audios: [{ url: 'https://example.com/voice.mp3', name: '角色1的音色' }]
        });
        assert.equal(full.duration, 5);
        assert.equal(typeof full.duration, 'number');
        assert.equal(full.ratio, '9:16');
        assert.equal(full.resolution, '1080p');
        assert.deepEqual(plain(full.images), [
            'https://example.com/char1.png',
            { url: 'https://example.com/scene1.png', name: '场景1' }
        ]);
        const supportsReferenceMedia = 'videos' in full;
        assert.equal(supportsReferenceMedia, binding.model_name !== 'seedance-2.0-900');
        if (supportsReferenceMedia) {
            assert.deepEqual(plain(full.videos), ['https://example.com/motion.mp4']);
            assert.deepEqual(plain(full.audios), [{ url: 'https://example.com/voice.mp3', name: '角色1的音色' }]);
        } else {
            assert.equal('audios' in full, false);
        }
    }
});

test('submit response keeps the upstream task id', async () => {
    for (const binding of bindings) {
        const response = jsonata(binding.resp_mapping);
        const result = await response.evaluate({ id: 'task_up_1', object: 'video', model: binding.model_name, status: 'queued', progress: 0, created_at: 1725000000 });
        assert.equal(result.task_id, 'task_up_1');
        assert.equal(result.id, 'task_up_1');
        assert.equal(result.status, 'queued');
        assert.equal(result.created_at, 1725000000);
        // A task_id-only upstream response must still map.
        assert.equal((await response.evaluate({ task_id: 'task_up_2', status: 'queued' })).task_id, 'task_up_2');
    }
});

test('poll mapping normalizes statuses and lifts result_urls to video_url', async () => {
    for (const binding of bindings) {
        const poll = jsonata(binding.poll_mapping);
        for (const [upstream, downstream] of Object.entries({ queued: 'queued', in_progress: 'processing', unknown: 'queued', failed: 'failed' })) {
            const result = await poll.evaluate({ status: upstream, progress: 30, created_at: 1725000000 });
            assert.equal(result.status, downstream);
            assert.equal(result.progress, 30);
            assert.equal(result.video_url, '');
        }
        const done = await poll.evaluate({
            id: 'task_up_1',
            object: 'video',
            model: binding.model_name,
            status: 'completed',
            progress: 100,
            created_at: 1725000000,
            completed_at: 1725000120,
            result_urls: ['https://m.jiasuapi.com/media/xxxx.mp4']
        });
        assert.equal(done.status, 'completed');
        assert.equal(done.progress, 100);
        assert.equal(done.video_url, 'https://m.jiasuapi.com/media/xxxx.mp4');
        assert.equal(done.object, 'https://m.jiasuapi.com/media/xxxx.mp4');
        assert.equal(done.completed_at, 1725000120);
        const failed = await poll.evaluate({ status: 'failed', message: 'content policy', created_at: 1725000000 });
        assert.equal(failed.status, 'failed');
        assert.equal(failed.error, 'content policy');
        // created_at must fall back to a Unix second timestamp when upstream omits it.
        const now = Math.floor(Date.now() / 1000);
        const noTimestamp = await poll.evaluate({ status: 'queued' });
        assert.ok(Math.abs(noTimestamp.created_at - now) <= 5);
    }
});
