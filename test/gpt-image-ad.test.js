// 校验渠道 gpt-image-ad（https://stars739.top）在 gpt-image-2 上的映射。
// 只做本地表达式求值，不访问上游、不产生计费请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const cfg = require('../scripts/gpt-image-ad-config');

const evaluate = async (expression, data) => JSON.parse(JSON.stringify(await jsonata(expression).evaluate(data)));

test('渠道信息与上游事实一致', () => {
    assert.equal(cfg.channel.name, 'gpt-image-ad');
    assert.equal(cfg.channel.base_url, 'https://stars739.top');
    assert.equal(cfg.channel.auth_type, 'bearer');
    assert.match(cfg.channel.api_key, /^sk-/);
    assert.equal(cfg.UPSTREAM_MODEL, 'gpt-image-2');
    // 上游成图是 base64 data URL，必须开响应侧转图床；请求侧不需要（multipart 自己解码）。
    assert.equal(cfg.channel.convert_resp_base64_to_url, 1);
    assert.equal(cfg.channel.convert_base64_to_url, 0);
});

test('绑定是按下游模板走同步图片流程，只挂 gpt-image-2', () => {
    assert.equal(cfg.bindings.length, 1);
    const binding = cfg.bindings[0];
    assert.equal(binding.model_name, 'gpt-image-2');
    assert.equal(binding.route_path, '/v1/images/generations');
    assert.equal(binding.poll_path, null);
    assert.equal(binding.is_async, 0);
    assert.equal(binding.proxy_content, 0);
    assert.equal(binding.error_passthrough, 1);
    assert.equal(binding.status, 1);
});

test('映射都是合法 jsonata 表达式', async () => {
    for (const expression of [cfg.req_mapping, cfg.resp_mapping]) {
        assert.doesNotThrow(() => jsonata(expression));
    }
    await jsonata(cfg.req_mapping).evaluate({ prompt: 'x' });
    await jsonata(cfg.resp_mapping).evaluate({ data: [{ url: 'data:image/png;base64,AAAA' }] });
});

test('文生图：/v1/images/generations 的 JSON 报文（与上游文档示例逐字一致）', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        prompt: '生成一张横向角色设定图',
        quality: 'high',
        n: 1,
        size: '1792x1024',
        response_format: 'url'
    });
    assert.deepEqual(mapped, {
        _route_path: '/v1/images/generations',
        model: 'gpt-image-2',
        prompt: '生成一张横向角色设定图',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
    assert.equal('messages' in mapped, false);
    assert.equal('files' in mapped, false);
    assert.equal('_request_format' in mapped, false);
});

test('文生图：画幅换算、缺省值与 response_format 归一', async () => {
    const defaults = await evaluate(cfg.req_mapping, { prompt: 'x' });
    assert.equal(defaults._route_path, '/v1/images/generations');
    assert.equal(defaults.size, '1024x1024');
    assert.equal(defaults.quality, 'high');
    assert.equal(defaults.n, 1);
    assert.equal(defaults.response_format, 'url');

    const ratios = { '16:9': '1792x1024', '9:16': '1024x1792', '1:1': '1024x1024', '4:3': '1536x1152', '3:4': '1152x1536' };
    for (const [ratio, pixels] of Object.entries(ratios)) {
        assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', size: ratio })).size, pixels, `size=${ratio}`);
    }
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', response_format: { type: 'b64_json' } })).response_format, 'b64_json');
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', response_format: '  ' })).response_format, 'url');
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', quality: '' })).quality, 'high');
});

test('文生图：下游 OpenAI messages 形态也能取到提示词（上游仍只发 prompt）', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        size: '16:9',
        messages: [{ role: 'user', content: '生成2人的合照' }]
    });
    assert.equal(mapped._route_path, '/v1/images/generations');
    assert.equal(mapped.prompt, '生成2人的合照');
    assert.equal('messages' in mapped, false);
});

test('图生图：/v1/images/edits 的 multipart（fields + 可重复 image 文件）', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        prompt: '生成2人的合照',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url',
        images: ['data:image/png;base64,AAAA', 'https://files.mmg.lat/u/b.png']
    });
    assert.equal(mapped._route_path, '/v1/images/edits');
    assert.equal(mapped._request_format, 'multipart/form-data');
    assert.deepEqual(mapped.fields, {
        model: 'gpt-image-2',
        prompt: '生成2人的合照',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
    assert.deepEqual(mapped.files, [
        { field: 'image', source: 'data:image/png;base64,AAAA', filename: 'image-1' },
        { field: 'image', source: 'https://files.mmg.lat/u/b.png', filename: 'image-2' }
    ]);

    // 参考图放在 messages[0].content 的 image_url 段里同样走 edits。
    const fromParts = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: '参考第一张图' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        }]
    });
    assert.equal(fromParts._route_path, '/v1/images/edits');
    assert.equal(fromParts.fields.prompt, '参考第一张图');
    assert.deepEqual(fromParts.files, [{ field: 'image', source: 'data:image/png;base64,AAAA', filename: 'image-1' }]);

    // 没有有效参考图时不能误走 edits。
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', images: [] }))._route_path, '/v1/images/generations');
});

test('响应归一：data URL / b64_json 拆成裸 base64 放进 url，url 模式给链接，空响应给空串', async () => {
    const upstream = {
        created: 1792032517,
        background: 'opaque',
        data: [{
            generation_id: 'c0c4362c-3dd5-44e1-8a8b-3ac176724d8c',
            model: 'gpt-image-2',
            size: '1774x887',
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
        }],
        output_format: 'png',
        quality: 'medium',
        size: '1774x887'
    };
    // 上游把图放在 data URL 里：映射拆出裸 base64 放进 url，渠道开关随后会换成图床链接。
    assert.deepEqual(await evaluate(cfg.resp_mapping, upstream), {
        model: 'gpt-image-2',
        url: 'iVBORw0KGgoAAAANSUhEUg=='
    });

    // 只回 b64_json 的形态（response_format=b64_json）同样把 base64 放进 url。
    assert.deepEqual(await evaluate(cfg.resp_mapping, { data: [{ b64_json: 'AAAA' }] }), {
        model: 'gpt-image-2',
        url: 'AAAA'
    });
    // chat 分支的 Markdown 图片保持兼容。
    assert.equal((await evaluate(cfg.resp_mapping, { choices: [{ message: { content: '![img](https://cdn/y.png)' } }] })).url, 'https://cdn/y.png');
    // 错误体 / 空响应不造链接，但结构保持 model + url。
    for (const payload of [{}, { error: { message: 'boom' } }]) {
        assert.deepEqual(await evaluate(cfg.resp_mapping, payload), { model: 'gpt-image-2', url: '' });
    }
});
