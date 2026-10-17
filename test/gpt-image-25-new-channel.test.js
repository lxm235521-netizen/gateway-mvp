const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const jsonata = require('jsonata');
const { channel, channels, models, bindings, req_mapping, resp_mapping, LOGICAL_MODEL_NAME, UPSTREAM_MODEL_NAME } = require('../scripts/gpt-image-25-new-channel-config');

// 复用 server.js 真实的 multipart 编码与上游 URL 解析逻辑，不发送任何真实生成请求。
const filename = path.resolve(__dirname, '../server.js');
const nativeRequire = createRequire(filename);
const context = vm.createContext({
    require(name) { return name === './db' ? {} : nativeRequire(name); },
    module: { exports: {} }, __dirname: path.dirname(filename), process, console, Buffer, URL
});
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
const buildPostOptions = vm.runInContext('buildPostOptions', context);
const resolveUpstreamUrl = vm.runInContext('resolveUpstreamUrl', context);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const dataUrl = 'data:image/png;base64,' + png.toString('base64');
const jpegDataUrl = 'data:image/jpeg;base64,' + png.toString('base64');
const mapping = jsonata(req_mapping);
const response = jsonata(resp_mapping);
const plain = value => JSON.parse(JSON.stringify(value));

const generationsUrl = 'http://38.127.51.106:4599/v1/images/generations';
const editsUrl = 'http://38.127.51.106:4599/v1/images/edits';

test('渠道指向新上游，逻辑模型复用 gpt-image-2.5', () => {
    assert.equal(channels.length, 1);
    assert.equal(channel.name, 'gpt-image-2.5 新渠道');
    assert.equal(channel.base_url, 'http://38.127.51.106:4599');
    assert.equal(channel.auth_type, 'bearer');
    assert.equal(channel.status, 1);
    assert.equal(channel.api_key, 'sk-F4LDJcn1b5s5JVB0gTHWS7Z75MIYMOmqIUYgmg6zzWTm9EaN');

    assert.equal(LOGICAL_MODEL_NAME, 'gpt-image-2.5');
    assert.equal(UPSTREAM_MODEL_NAME, 'gpt-image-2.5');
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].model_name, 'gpt-image-2.5');
    assert.equal(bindings[0].route_path, '/v1/images/generations');
    assert.equal(bindings[0].is_async, 0);
    assert.equal(bindings[0].status, 1);
    assert.equal(bindings[0].poll_mapping, null);
});

test('统一模板 · 无参考图 -> JSON images/generations，model 为 gpt-image-2.5', async () => {
    const mapped = await mapping.evaluate({ model: 'gpt-image-2.5', prompt: '一只猫', size: '16:9' });
    assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), generationsUrl);
    const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
    assert.deepEqual(plain(request.data), {
        model: 'gpt-image-2.5',
        prompt: '一只猫',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
    // 上游 chat/completions 不接受 response_format，本渠道必须不走到那个路由
    assert.notEqual(mapped._route_path, '/v1/chat/completions');
});

test('统一模板 · 有参考图 -> multipart images/edits，image 按文件重复', async () => {
    for (const count of [1, 2, 3]) {
        const mapped = await mapping.evaluate({
            model: 'gpt-image-2.5', prompt: '换成黄色背景', size: '1:1', images: Array(count).fill(dataUrl)
        });
        assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), editsUrl);
        const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
        const body = request.data.getBuffer();
        const text = body.toString('latin1');
        assert.match(request.options.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.equal((text.match(/name="image"; filename="image-\d+"/g) || []).length, count);
        assert.equal(body.includes(Buffer.from(png.toString('latin1'), 'latin1')), true);
        assert.equal(text.split(png.toString('latin1')).length - 1, count);
        for (const [key, value] of Object.entries({ model: 'gpt-image-2.5', size: '1024x1024', quality: 'high', n: '1', response_format: 'url' })) {
            assert.ok(body.includes(Buffer.from(`name="${key}"\r\n\r\n${value}\r\n`, 'utf8')), key);
        }
        for (const leaked of ['_route_path', '_request_format', 'files', 'fields']) {
            assert.equal(text.includes(leaked), false, leaked);
        }
    }
});

test('OpenAI messages 风格 · content 是字符串 -> 文生图', async () => {
    const mapped = await mapping.evaluate({
        model: 'gpt-image-2.5',
        response_format: { type: 'url' },
        size: '1792x1024',
        quality: 'high',
        n: 1,
        messages: [{ role: 'user', content: '生成一张真实摄影风格的城市夜景' }]
    });
    assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), generationsUrl);
    const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
    assert.deepEqual(plain(request.data), {
        model: 'gpt-image-2.5',
        prompt: '生成一张真实摄影风格的城市夜景',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
});

test('OpenAI messages 风格 · content 是 text+image_url 数组 -> 图生图并抽取参考图', async () => {
    const prompt = '参考这几张图片融合成城市夜景';
    const mapped = await mapping.evaluate({
        model: 'gpt-image-2.5',
        size: '1792x1024',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
                { type: 'image_url', image_url: { url: jpegDataUrl } }
            ]
        }]
    });
    assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), editsUrl);
    assert.equal(mapped.fields.prompt, prompt);
    assert.equal(mapped.files.length, 2);
    assert.deepEqual(plain(mapped.files.map(file => file.source)), [dataUrl, jpegDataUrl]);

    const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
    const body = request.data.getBuffer();
    assert.ok(body.includes(Buffer.from(prompt, 'utf8')));
    assert.equal(body.includes(Buffer.from('name="messages"', 'utf8')), false);
});

test('缺省参数：quality 强制 high、n 缺省 1、response_format 缺省 url（含 null）', async () => {
    const bare = await mapping.evaluate({ prompt: 'x' });
    assert.equal(bare.quality, 'high');
    assert.equal(bare.n, 1);
    assert.equal(bare.response_format, 'url');

    for (const quality of ['', '   ', null, undefined]) {
        assert.equal((await mapping.evaluate({ prompt: 'x', quality })).quality, 'high', `quality=${JSON.stringify(quality)}`);
    }
    for (const response_format of [null, {}, '', { type: null }, { type: '  ' }]) {
        assert.equal((await mapping.evaluate({ prompt: 'x', response_format })).response_format, 'url', `rf=${JSON.stringify(response_format)}`);
    }
    // 显式值保留，且对象形式归一成字符串（上游 chat 接口那种类型冲突不会出现）
    const explicit = await mapping.evaluate({ prompt: 'x', quality: 'low', n: 3, response_format: { type: 'b64_json' } });
    assert.equal(explicit.quality, 'low');
    assert.equal(explicit.n, 3);
    assert.equal(explicit.response_format, 'b64_json');
});

test('画幅换算与未知尺寸透传', async () => {
    const ratios = { '16:9': '1792x1024', '9:16': '1024x1792', '1:1': '1024x1024', '4:3': '1536x1152', '3:4': '1152x1536' };
    for (const [size, expected] of Object.entries(ratios)) {
        assert.equal((await mapping.evaluate({ prompt: 'x', size })).size, expected, size);
    }
    assert.equal((await mapping.evaluate({ prompt: 'x' })).size, '1024x1024');
    assert.equal((await mapping.evaluate({ prompt: 'x', size: '2048x2048' })).size, '2048x2048');
});

test('返回按文档第 4 节归一：url 模式给链接，b64_json 模式把 base64 放进 url', async () => {
    // 本渠道实测：response_format=url 时两个路由都返回 data[0].url
    assert.deepEqual(plain(await response.evaluate({
        created: 1791167407,
        data: [{ url: 'https://open.kcai.asia/images/a.png' }]
    })), { model: 'gpt-image-2.5', url: 'https://open.kcai.asia/images/a.png' });

    // chat 风格：Markdown 图片
    assert.deepEqual(plain(await response.evaluate({
        choices: [{ message: { content: '![generated image 1](https://open.kcai.asia/images/b.png)' } }]
    })), { model: 'gpt-image-2.5', url: 'https://open.kcai.asia/images/b.png' });

    // chat 风格的顶层 image.data[0].url
    assert.equal((await response.evaluate({
        choices: [{ message: { content: 'no markdown' } }],
        image: { data: [{ url: 'https://open.kcai.asia/images/c.png' }] }
    })).url, 'https://open.kcai.asia/images/c.png');

    // image_urls[]
    assert.equal((await response.evaluate({ image_urls: ['https://open.kcai.asia/images/d.png'] })).url, 'https://open.kcai.asia/images/d.png');

    // response_format=b64_json：上游只回 data[0].b64_json，没有 url —— 下游的 url 字段就是 base64
    const b64Json = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const b64 = plain(await response.evaluate({
        created: 1791167407,
        data: [{ revised_prompt: '一只猫', b64_json: b64Json, width: 1254, height: 1254 }],
        usage: {}
    }));
    assert.deepEqual(b64, { model: 'gpt-image-2.5', url: b64Json });

    // 上游把图放进 data URL 时同样拆成裸 base64
    assert.equal((await response.evaluate({
        data: [{ url: `data:image/png;base64,${b64Json}` }]
    })).url, b64Json);

    // 空响应 / 错误体拿不到图时 url 是空串，响应结构不变
    assert.deepEqual(plain(await response.evaluate({})), { model: 'gpt-image-2.5', url: '' });
});
