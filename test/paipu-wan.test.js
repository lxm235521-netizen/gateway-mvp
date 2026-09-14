const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { channel, bindings, capabilities } = require('../scripts/paipu-wan-config');

const plainObject = value => JSON.parse(JSON.stringify(value));

test('Paipu Wan bindings target the existing video channel', () => {
    assert.deepEqual(channel, {
        name: 'Paipu Video',
        base_url: 'https://api.paipu.net',
        auth_type: 'bearer'
    });
    assert.deepEqual(bindings.map(item => item.model_name), [
        'lec-vp-wan-3-0',
        'lec-vp-wan-3-0-prime'
    ]);
    for (const binding of bindings) {
        assert.equal(binding.route_path, '/v1/videos');
        assert.equal(binding.poll_path, '/v1/videos/${up_task_id}');
        assert.equal(binding.is_async, 1);
        assert.equal(binding.proxy_content, 1);
        assert.equal(binding.poll_throttle, 1);
    }
});

test('request mappings translate the gateway payload for both Wan models', async () => {
    for (const binding of bindings) {
        const mapping = jsonata(binding.req_mapping);
        const defaults = await mapping.evaluate({ prompt: 'test' });
        assert.deepEqual(plainObject(defaults), {
            model: binding.model_name,
            prompt: 'test',
            duration: capabilities.defaultSeconds,
            aspect_ratio: capabilities.defaultAspectRatio,
            resolution: capabilities.defaultResolution
        });

        const full = await mapping.evaluate({
            prompt: 'full',
            seconds: '30',
            aspect_ratio: '9:16',
            resolution: '1080p',
            images: ['https://example.com/a.jpg'],
            videos: ['https://example.com/a.mp4'],
            audios: ['https://example.com/a.wav']
        });
        assert.deepEqual(plainObject(full), {
            model: binding.model_name,
            prompt: 'full',
            duration: 30,
            aspect_ratio: '9:16',
            resolution: '1080p',
            images: ['https://example.com/a.jpg'],
            videos: ['https://example.com/a.mp4'],
            audios: ['https://example.com/a.wav']
        });
    }
});

test('response and poll mappings expose gateway task and result fields', async () => {
    for (const binding of bindings) {
        const response = await jsonata(binding.resp_mapping).evaluate({
            id: 'upstream-task',
            status: 'queued',
            model: binding.model_name
        });
        assert.equal(response.task_id, 'upstream-task');
        assert.equal(response.id, 'upstream-task');

        const processing = await jsonata(binding.poll_mapping).evaluate({
            status: 'in_progress',
            progress: 40
        });
        assert.equal(processing.status, 'processing');
        assert.equal(processing.progress, 40);

        const completed = await jsonata(binding.poll_mapping).evaluate({
            status: 'completed',
            progress: 90,
            metadata: { url: 'https://api.paipu.net/v1/videos/task/content?signature=test' }
        });
        assert.equal(completed.status, 'completed');
        assert.equal(completed.progress, 100);
        assert.equal(completed.video_url, 'https://api.paipu.net/v1/videos/task/content?signature=test');
        assert.equal(completed.object, 'https://api.paipu.net/v1/videos/task/content?signature=test');
    }
});
