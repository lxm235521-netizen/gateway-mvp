// 校验渠道 gpt-image-duolapi（#40）上 gpt-image-2 的映射：
// 文生图走 POST /v1/images/generations（JSON + prompt），图生图走 /v1/images/edits（multipart）。
// 只做本地表达式求值，不访问上游、不产生计费请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const cfg = require('../scripts/duolapi-gpt-image-2-config');

const evaluate = async (expression, data) => JSON.parse(JSON.stringify(await jsonata(expression).evaluate(data)));

test('渠道信息与上游事实一致', () => {
    assert.equal(cfg.channel.name, 'gpt-image-duolapi');
    assert.equal(cfg.channel.base_url, 'https://api2.duolapi.cn');
    assert.equal(cfg.channel.auth_type, 'bearer');
    assert.equal(cfg.channel.logical_model, 'gpt-image-2');
    assert.equal(cfg.channel.upstream_model, 'gpt-image-fast');
    assert.equal(cfg.channel.text_route_path, '/v1/images/generations');
    assert.equal(cfg.channel.image_route_path, '/v1/images/edits');
});

test('映射（含历史版本）都是合法 jsonata 表达式', async () => {
    for (const expression of [cfg.req_mapping, cfg.resp_mapping, ...cfg.legacy_req_mappings, ...cfg.legacy_resp_mappings]) {
        assert.doesNotThrow(() => jsonata(expression));
    }
    await jsonata(cfg.req_mapping).evaluate({ prompt: 'x' });
    await jsonata(cfg.resp_mapping).evaluate({ data: [{ url: 'https://x/y.png' }] });
});

test('文生图：走 /v1/images/generations 的 OpenAI 报文（prompt，不再是 messages）', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        prompt: '一只在月光下的猫，插画风格',
        size: '16:9',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
    assert.deepEqual(mapped, {
        _route_path: '/v1/images/generations',
        model: 'gpt-image-fast',
        prompt: '一只在月光下的猫，插画风格',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
    assert.equal('messages' in mapped, false);
    assert.equal('_request_format' in mapped, false);
    assert.equal('files' in mapped, false);
});

test('文生图：缺省值与画幅换算，response_format 对象/空值归一成字符串', async () => {
    const defaults = await evaluate(cfg.req_mapping, { model: 'gpt-image-2', prompt: 'x' });
    assert.equal(defaults._route_path, '/v1/images/generations');
    assert.equal(defaults.size, '1024x1024');
    assert.equal(defaults.quality, 'high');
    assert.equal(defaults.n, 1);
    assert.equal(defaults.response_format, 'url');

    const ratios = { '16:9': '1792x1024', '9:16': '1024x1792', '1:1': '1024x1024', '4:3': '1536x1152', '3:4': '1152x1536' };
    for (const [ratio, pixels] of Object.entries(ratios)) {
        assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', size: ratio })).size, pixels);
    }
    // 已经是像素、或任意上游能识别的值时原样透传。
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', size: '1536x1024' })).size, '1536x1024');
    // 对象写法（OpenAI 原生）与空白值都归一成字符串 url。
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', response_format: { type: 'b64_json' } })).response_format, 'b64_json');
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', response_format: '   ' })).response_format, 'url');
    // quality 空值补 high。
    assert.equal((await evaluate(cfg.req_mapping, { prompt: 'x', quality: '' })).quality, 'high');
});

test('文生图：messages 形态的下游请求仍能取到提示词，但上游只发 prompt', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        size: '16:9',
        messages: [{ role: 'user', content: '城市夜景，霓虹灯' }]
    });
    assert.equal(mapped._route_path, '/v1/images/generations');
    assert.equal(mapped.prompt, '城市夜景，霓虹灯');
    assert.equal('messages' in mapped, false);

    const fromParts = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        messages: [{ role: 'user', content: [{ type: 'text', text: '换成都市夜景' }] }]
    });
    assert.equal(fromParts.prompt, '换成都市夜景');
    assert.equal('materials' in fromParts, false);
});

test('图生图：仍走 /v1/images/edits 的 multipart（fields + 可重复的 image 文件）', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        prompt: '参考这两张图融合成城市夜景',
        size: '16:9',
        images: ['https://files.mmg.lat/u/a.jpg', { url: 'https://files.mmg.lat/u/b.png' }, '', null]
    });
    assert.equal(mapped._route_path, '/v1/images/edits');
    assert.equal(mapped._request_format, 'multipart/form-data');
    assert.deepEqual(mapped.fields, {
        model: 'gpt-image-fast',
        prompt: '参考这两张图融合成城市夜景',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
    assert.deepEqual(mapped.files, [
        { field: 'image', source: 'https://files.mmg.lat/u/a.jpg', filename: 'image-1' },
        { field: 'image', source: 'https://files.mmg.lat/u/b.png', filename: 'image-2' }
    ]);
});

test('图生图：参考图也可以放在 messages[0].content 的 image_url 段里', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gpt-image-2',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: '参考第一张图的构图' },
                { type: 'image_url', image_url: { url: 'https://files.mmg.lat/u/a.jpg' } }
            ]
        }]
    });
    assert.equal(mapped._route_path, '/v1/images/edits');
    assert.equal(mapped.fields.prompt, '参考第一张图的构图');
    assert.deepEqual(mapped.files, [{ field: 'image', source: 'https://files.mmg.lat/u/a.jpg', filename: 'image-1' }]);

    // 没有有效参考图时不能误走 edits 分支。
    const noImage = await evaluate(cfg.req_mapping, { prompt: 'x', images: [] });
    assert.equal(noImage._route_path, '/v1/images/generations');
});

test('响应归一：data[0].url / data[0].b64_json / chat Markdown，空响应不造链接', async () => {
    assert.equal((await evaluate(cfg.resp_mapping, { data: [{ url: 'https://cdn/x.png' }] })).url, 'https://cdn/x.png');
    assert.equal((await evaluate(cfg.resp_mapping, { data: [{ b64_json: 'AAAA' }] })).url, 'data:image/png;base64,AAAA');
    assert.equal((await evaluate(cfg.resp_mapping, { choices: [{ message: { content: '![img](https://cdn/y.png)' } }] })).url, 'https://cdn/y.png');
    assert.equal((await evaluate(cfg.resp_mapping, {})).url, undefined);
    assert.equal((await evaluate(cfg.resp_mapping, { error: { message: 'boom' } })).url, undefined);
    assert.equal((await evaluate(cfg.resp_mapping, { data: [{ b64_json: null }] })).url, undefined);
});
