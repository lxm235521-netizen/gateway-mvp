const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { bindings, model, channel, namedModels, MODEL_NAME, TEMPLATE_KEY } = require('../scripts/vylai-sd20-fast-config');
const plain = value => JSON.parse(JSON.stringify(value));

const binding = bindings[0];
const template = '75api-sd20-fast-20260919';

test('sd20-fast config targets the existing Vylai channel and its SD 2.0 Fast template', () => {
    assert.equal(channel.name, 'Vylai MiniMax H3');
    assert.equal(channel.base_url, 'https://queueapi.vylai.com');
    assert.equal(channel.auth_type, 'x-auth-token');
    assert.equal(model.template_key, template);
    assert.equal(binding.model_name, '75api-sd20-fast-20260919');
    assert.equal(binding.route_path, '/openapi/tasks/create');
    assert.equal(binding.poll_path, '/openapi/tasks/${up_task_id}');
    assert.equal(binding.is_async, 1);
    // data.result_oss_url 是公开直链，与同渠道 MiniMax H3 绑定一致返回直链。
    assert.equal(binding.proxy_content, 0);
});

// 下游要按模型名区分分辨率：两个逻辑模型共用同一上游模板与同一份轮询映射，
// 只在请求映射里把 config_values.resolution 写死，并且忽略下游传来的 resolution。
test('resolution-named models pin config_values.resolution regardless of downstream input', async () => {
    assert.deepEqual(namedModels.map(item => item.model_name), ['seedance-2.0-933-480p', 'seedance-2.0-933-720p']);
    assert.equal(bindings.length, 3);

    for (const item of namedModels) {
        const expected = item.model_name.endsWith('-720p') ? '720p' : '480p';

        // 与同渠道其它绑定同模板、同路径、同轮询映射形态。
        assert.equal(item.template_key, template);
        assert.equal(item.route_path, '/openapi/tasks/create');
        assert.equal(item.poll_path, '/openapi/tasks/${up_task_id}');
        assert.equal(item.proxy_content, 0);
        assert.equal(item.resp_mapping.includes(item.model_name), true, 'resp_mapping 应带上逻辑模型名');
        assert.equal(item.poll_mapping.includes(item.model_name), true, 'poll_mapping 应带上逻辑模型名');
        assert.equal(item.remark.includes(`写死为 ${expected}`), true, 'remark 应说明分辨率来源');

        const request = jsonata(item.req_mapping);
        const plainRequest = await request.evaluate({ prompt: '一只兔子在草地上走动', seconds: '6' });
        assert.equal(plainRequest.template_key, template);
        assert.equal(plainRequest.config_values.resolution, expected);
        assert.equal(plainRequest.config_values.duration, 6);
        assert.equal(plainRequest.config_values.mode, 'reference');

        // 下游传任意 resolution（含另一档位）都不会改变写死的分辨率。
        for (const resolution of ['480p', '720p', '1080P', '4k', '', null, 123]) {
            const out = await request.evaluate({ prompt: 'x', resolution });
            assert.equal(out.config_values.resolution, expected, `${item.model_name} 传 resolution=${resolution} 时不应被覆盖`);
        }

        // 其余字段的默认值与回落规则与通用模型一致。
        const defaults = await request.evaluate({ prompt: 'x' });
        assert.deepEqual(plain(defaults.config_values), {
            mode: 'reference',
            duration: 5,
            resolution: expected,
            ratio: '9:16',
            watermark: false,
            generate_audio: true
        });
        assert.equal((await request.evaluate({ prompt: 'x', seconds: '99' })).config_values.duration, 5);
        assert.equal((await request.evaluate({ prompt: 'x', aspect_ratio: '1:1' })).config_values.ratio, '9:16');
        assert.equal('image_path' in defaults, false);
        const withMedia = await request.evaluate({ prompt: 'x', images: ['https://example.com/a.jpg'], audios: ['https://example.com/a.mp3'] });
        assert.deepEqual(plain(withMedia.image_path), ['https://example.com/a.jpg']);
        assert.deepEqual(plain(withMedia.audio_path), ['https://example.com/a.mp3']);
    }
});

test('req mapping builds the SD 2.0 Fast create body with documented defaults', async () => {
    const request = jsonata(binding.req_mapping);

    const defaults = await request.evaluate({ prompt: '一只兔子在草地上走动' });
    assert.equal(defaults.template_key, template);
    assert.equal(defaults.extra_data.text, '一只兔子在草地上走动');
    assert.deepEqual(plain(defaults.config_values), {
        mode: 'reference',
        duration: 5,
        resolution: '480p',
        ratio: '9:16',
        watermark: false,
        generate_audio: true
    });
    assert.equal(defaults.priority, 0);
    // 没有素材时不下发空数组：上游按 mode 自行校验必填素材。
    for (const key of ['image_path', 'audio_path', 'video_path']) {
        assert.equal(key in defaults, false, `${key} 不应为空数组出现`);
    }

    const full = await request.evaluate({
        prompt: '让图一中的小兔子在图二的场景中自然走动',
        seconds: '10',
        resolution: '720p',
        aspect_ratio: '16:9',
        mode: 'reference',
        images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
        audios: ['https://example.com/a.mp3'],
        videos: ['https://example.com/v.mp4']
    });
    assert.equal(full.config_values.duration, 10);
    assert.equal(full.config_values.resolution, '720p');
    assert.equal(full.config_values.ratio, '16:9');
    assert.deepEqual(plain(full.image_path), ['https://example.com/a.jpg', 'https://example.com/b.jpg']);
    assert.deepEqual(plain(full.audio_path), ['https://example.com/a.mp3']);
    assert.deepEqual(plain(full.video_path), ['https://example.com/v.mp4']);
});

test('req mapping clamps seconds to the 4-15 range and rejects unknown config values', async () => {
    const request = jsonata(binding.req_mapping);

    // 上游只接受 4–15 的整数秒；文档范围外的值回落默认 5，避免上游 400。
    assert.equal((await request.evaluate({ prompt: 'x', seconds: '15' })).config_values.duration, 15);
    assert.equal((await request.evaluate({ prompt: 'x', seconds: 4 })).config_values.duration, 4);
    assert.equal((await request.evaluate({ prompt: 'x', seconds: '10' })).config_values.duration, 10);
    // 小数先四舍五入成整数秒，再判区间：3.6 舍入成 4 属合法范围，3.4 舍入成 3 越界回落 5。
    assert.equal((await request.evaluate({ prompt: 'x', seconds: '5.5' })).config_values.duration, 6);
    assert.equal((await request.evaluate({ prompt: 'x', seconds: 4.4 })).config_values.duration, 4);
    assert.equal((await request.evaluate({ prompt: 'x', seconds: '3.6' })).config_values.duration, 4);
    for (const seconds of ['3', 0, -1, '16', 'abc', '', null, '3.4', 16.4]) {
        assert.equal((await request.evaluate({ prompt: 'x', seconds })).config_values.duration, 5, `seconds=${seconds} 应回落 5`);
    }

    // resolution 只支持小写 480p / 720p（Wan 3.0 才是大写 P），ratio 只支持 9:16 / 16:9。
    assert.equal((await request.evaluate({ prompt: 'x', resolution: '1080P' })).config_values.resolution, '480p');
    assert.equal((await request.evaluate({ prompt: 'x', resolution: '720P' })).config_values.resolution, '480p');
    assert.equal((await request.evaluate({ prompt: 'x', aspect_ratio: '1:1' })).config_values.ratio, '9:16');
    assert.equal((await request.evaluate({ prompt: 'x', aspect_ratio: 16 / 9 })).config_values.ratio, '9:16');

    // mode 只允许上游声明的四种；未声明 mode 时用上游默认的 reference。
    for (const mode of ['reference', 't2v', 'first_frame', 'first_last']) {
        assert.equal((await request.evaluate({ prompt: 'x', mode })).config_values.mode, mode);
    }
    for (const mode of ['other', '', null, 5]) {
        assert.equal((await request.evaluate({ prompt: 'x', mode })).config_values.mode, 'reference');
    }

    // 未知配置字段会被上游以「未知配置字段」拒绝，映射只输出模板声明的字段。
    const keys = Object.keys((await request.evaluate({
        prompt: 'x', seconds: '5', resolution: '720p', aspect_ratio: '16:9',
        quality: 'high', n: 1, size: '16:9', response_format: 'url', watermark: true, generate_audio: false
    })).config_values).sort();
    assert.deepEqual(keys, ['duration', 'generate_audio', 'mode', 'ratio', 'resolution', 'watermark']);
    assert.equal((await request.evaluate({ prompt: 'x', watermark: true })).config_values.watermark, false);
    assert.equal((await request.evaluate({ prompt: 'x', generate_audio: false })).config_values.generate_audio, true);
});

test('resp mapping carries data.task_id and never invents one on an error body', async () => {
    const response = jsonata(binding.resp_mapping);

    const ok = await response.evaluate({ code: 200, msg: 'success', data: { task_id: 'up-1', prompt_id: 'p-1' } });
    assert.equal(ok.task_id, 'up-1');
    assert.equal(ok.status, 'queued');
    assert.equal(ok.progress, 0);
    assert.equal(ok.object, 'video');
    assert.equal(ok.model, '75api-sd20-fast-20260919');

    // 上游创建失败（HTTP 401 / 400 未知配置字段）时响应体没有 data.task_id，
    // 映射不能凭空造一个任务号，server.js 会因为没有 task_id 返回 502。
    for (const body of [{ code: 400, msg: '未知配置字段: quality' }, { code: 401, msg: 'unauthorized' }, {}]) {
        assert.equal((await response.evaluate(body)).task_id, undefined);
    }
});

test('poll mapping normalizes pending/preparing/running and returns the result link', async () => {
    const poll = jsonata(binding.poll_mapping);
    const okData = { task_id: 'up-1', created_at: '2026-09-19T11:13:31+08:00', updated_at: '2026-09-19T11:15:00+08:00' };

    for (const [upstream, downstream] of Object.entries({ pending: 'queued', preparing: 'processing', running: 'processing' })) {
        const out = await poll.evaluate({ code: 200, msg: 'success', data: { ...okData, status: upstream, result_oss_url: null } });
        assert.equal(out.status, downstream, `status=${upstream}`);
        assert.equal(out.model, '75api-sd20-fast-20260919');
        assert.equal(out.error, null);
        assert.equal(out.video_url, null);
        assert.equal(out.created_at, 1789787611);
    }

    const completed = await poll.evaluate({ code: 200, msg: 'success', data: { ...okData, status: 'completed', result_oss_url: 'https://oss.vylai.com/a.mp4' } });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, 100);
    assert.equal(completed.video_url, 'https://oss.vylai.com/a.mp4');
    assert.equal(completed.object, 'https://oss.vylai.com/a.mp4');
    assert.equal(completed.error, null);
    assert.equal(completed.completed_at, 1789787700);

    // 上游把错误放在 error_message / display_error_message，状态可能还停在 running。
    const failed = await poll.evaluate({ code: 200, msg: 'success', data: { ...okData, status: 'running', result_oss_url: null, error_message: 'first_frame mode requires an input image' } });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.progress, 100);
    assert.equal(failed.error.message, 'first_frame mode requires an input image');
    assert.equal(failed.error.code, 'video_generation_failed');
    assert.equal('video_url' in failed, false);

    const canceled = await poll.evaluate({ code: 200, msg: 'success', data: { ...okData, status: 'canceled' } });
    assert.equal(canceled.status, 'failed');
    assert.equal(canceled.error.code, 'video_generation_cancelled');

    // 响应不带 data 包装或整个是错误体时也必须给出终态，否则下游会一直轮询。
    const unwrapped = await poll.evaluate({ code: 500, msg: 'Internal Server Error' });
    assert.equal(unwrapped.status, 'failed');
    assert.equal(unwrapped.error.message, 'Internal Server Error');
    const empty = await poll.evaluate({});
    assert.equal(empty.status, 'failed');
    assert.equal(empty.error.code, 'video_generation_failed');
});
