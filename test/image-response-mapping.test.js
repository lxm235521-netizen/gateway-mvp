const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { buildImageResponseMapping } = require('../scripts/image-response-mapping');

// 共享的图片响应归一映射：gpt-image-2 / gpt-image-2.5 等渠道都用它生成 resp_mapping。
// 下游契约固定为 { model, url }，url 是 http 链接或裸 base64：
//   - response_format=url      -> url = data[0].url（http 链接）
//   - response_format=b64_json -> url = data[0].b64_json（裸 base64，上游响应里没有 url 字段）
// 核心回归点：旧映射只取 data[0].url，b64 响应会让 url 变 undefined，
// 下游只剩 { model, created }，图片信息整段丢失。

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const bigBase64 = 'iVBORw0KGgoAAAANSUhEUgAABOYAAATmCAIAAAAKnjl9AABcZmNhYlgAAFxm' + 'A'.repeat(200);
const httpUrl = 'https://cdn.example.com/a.png';
const dataUrl = `data:image/png;base64,${bigBase64}`;

const evaluate = async (modelName, payload) => {
    const expression = jsonata(buildImageResponseMapping(modelName));
    return JSON.parse(JSON.stringify(await expression.evaluate(payload)));
};

test('response_format=b64_json：data[0].b64_json 原样进 url', async () => {
    // 上游实测返回形状：{ created, data: [{ revised_prompt, b64_json, width, height }], usage }
    const result = await evaluate('gpt-image-2.5', {
        created: 1792232414,
        data: [{ revised_prompt: 'a red dot', b64_json: pngBase64, width: 1254, height: 1254 }],
        usage: {}
    });
    assert.deepEqual(result, { model: 'gpt-image-2.5', url: pngBase64 });
});

test('response_format=url：data[0].url 进 url', async () => {
    assert.deepEqual(await evaluate('gpt-image-2', {
        created: 1792232414,
        data: [{ url: httpUrl }]
    }), { model: 'gpt-image-2', url: httpUrl });
});

test('同时给 url 与 b64_json 时优先返回链接', async () => {
    const result = await evaluate('gpt-image-2', {
        created: 1,
        data: [{ url: httpUrl, b64_json: bigBase64 }]
    });
    assert.equal(result.url, httpUrl);
});

test('data[0].url 是 data URL 时拆成裸 base64', async () => {
    const result = await evaluate('gpt-image-2', { created: 1, data: [{ url: dataUrl }] });
    assert.equal(result.url, bigBase64);
});

test('chat/completions 形态：Markdown 图片、data URL、裸 base64 都能取到图', async () => {
    assert.equal((await evaluate('gpt-image-2', {
        created: 1,
        choices: [{ message: { content: `![image_1](${httpUrl})` } }]
    })).url, httpUrl);

    assert.equal((await evaluate('gpt-image-2', {
        created: 1,
        choices: [{ message: { content: `![image_1](${dataUrl})` } }]
    })).url, bigBase64);

    assert.equal((await evaluate('gpt-image-2', {
        created: 1,
        choices: [{ message: { content: `\n ${bigBase64} \n` } }]
    })).url, bigBase64);

    assert.equal((await evaluate('gpt-image-2', {
        created: 1,
        choices: [{ message: { content: [{ type: 'text', text: dataUrl }] } }]
    })).url, bigBase64);
});

test('image 包装、image_urls 与 image.url 也兼容', async () => {
    assert.equal((await evaluate('gpt-image-2', { image: { data: [{ url: httpUrl }] } })).url, httpUrl);
    assert.equal((await evaluate('gpt-image-2', { image_urls: [httpUrl] })).url, httpUrl);
    assert.equal((await evaluate('gpt-image-2', { image: { url: httpUrl } })).url, httpUrl);
    assert.equal((await evaluate('gpt-image-2', { image: { data: [{ b64_json: pngBase64 }] } })).url, pngBase64);
});

test('非图片内容（错误话术、空响应、顶层裸 url）不会变成图片', async () => {
    for (const payload of [
        { choices: [{ message: { content: '由于我这边发生了错误，我未能生成图片。' } }] },
        { choices: [{ message: { content: '请提供更多细节' } }] },
        { error: { message: 'rate limited' } },
        {},
        { url: httpUrl }
    ]) {
        const result = await evaluate('gpt-image-2', payload);
        assert.deepEqual(result, { model: 'gpt-image-2', url: '' }, JSON.stringify(payload));
    }
});

test('返回体只有 model 与 url 两个字段（不再带 created / b64_json / data）', async () => {
    const result = await evaluate('gpt-image-2.5', { created: 1, data: [{ b64_json: pngBase64 }] });
    assert.deepEqual(Object.keys(result).sort(), ['model', 'url']);
});

test('model 名按传入的逻辑模型写入', async () => {
    assert.equal((await evaluate('gpt-image-2', { data: [{ url: httpUrl }] })).model, 'gpt-image-2');
    assert.equal((await evaluate('gpt-image-2.5', { data: [{ url: httpUrl }] })).model, 'gpt-image-2.5');
});
