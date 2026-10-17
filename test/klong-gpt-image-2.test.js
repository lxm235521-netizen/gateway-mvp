const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const jsonata = require('jsonata');
const { channel, channels, bindings, req_mapping, resp_mapping, legacy_req_mappings } = require('../scripts/klong-gpt-image-2-config');

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

const generationsUrl = 'https://api.klong.lat/v1/images/generations';
const editsUrl = 'https://api.klong.lat/v1/images/edits';

test('渠道定义指向 api.klong.lat 且带 Bearer 密钥', () => {
    assert.equal(channels.length, 1);
    assert.equal(channel.name, 'gpt图片生成 Klong');
    assert.equal(channel.base_url, 'https://api.klong.lat');
    assert.equal(channel.auth_type, 'bearer');
    assert.equal(channel.status, 1);
    assert.match(channel.api_key, /^sk-/);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].model_name, 'gpt-image-2');
    assert.equal(bindings[0].route_path, '/v1/chat/completions');
    assert.equal(bindings[0].is_async, 0);
    assert.equal(bindings[0].proxy_content, 0);
    assert.equal(bindings[0].error_passthrough, 1);
    assert.equal(bindings[0].status, 1);
});

test('统一模板 · 无参考图 -> JSON images/generations（顶层 prompt），response_format 是字符串', async () => {
    for (const images of [undefined, []]) {
        const mapped = await mapping.evaluate({ model: 'gpt-image-2', prompt: '一只猫', images, size: '16:9' });
        assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), generationsUrl);
        const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
        assert.deepEqual(plain(request.data), {
            model: 'gpt-image-2',
            prompt: '一只猫',
            size: '1792x1024',
            quality: 'high',
            n: 1,
            response_format: 'url'
        });
    }
});

test('统一模板 · 有参考图 -> multipart images/edits，image 按文件重复', async () => {
    for (const count of [1, 2, 3]) {
        const mapped = await mapping.evaluate({
            model: 'gpt-image-2', prompt: '换成黄色背景', size: '1:1', images: Array(count).fill(dataUrl)
        });
        assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), editsUrl);
        const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
        const body = request.data.getBuffer().toString('latin1');
        assert.match(request.options.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.equal((body.match(/name="image"; filename="image-\d+"/g) || []).length, count);
        assert.equal((body.match(/Content-Type: image\/png/g) || []).length, count);
        assert.equal(body.split(png.toString('latin1')).length - 1, count);
        for (const [key, value] of Object.entries({ model: 'gpt-image-2', size: '1024x1024', quality: 'high', n: '1', response_format: 'url' })) {
            assert.ok(body.includes(`name="${key}"\r\n\r\n${value}\r\n`), key);
        }
        for (const leaked of ['_route_path', '_request_format', 'files', 'fields']) {
            assert.equal(body.includes(leaked), false, leaked);
        }
    }
});

test('OpenAI 风格 · messages[0].content 是字符串 -> 文生图（提示词进顶层 prompt）', async () => {
    const mapped = await mapping.evaluate({
        model: 'gpt-image-2',
        response_format: { type: 'url' },
        size: '1792x1024',
        quality: 'high',
        n: 1,
        messages: [{ role: 'user', content: '生成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影' }]
    });
    assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), generationsUrl);
    const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
    assert.deepEqual(plain(request.data), {
        model: 'gpt-image-2',
        prompt: '生成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
});

test('OpenAI 风格 · content 是 text+image_url 数组 -> 图生图并抽取参考图', async () => {
    const prompt = '参考这几张图片，将主体融合成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影';
    const mapped = await mapping.evaluate({
        model: 'gpt-image-2',
        size: '1792x1024',
        quality: 'high',
        n: 1,
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

    // 中文提示词是 UTF-8 字节，按字节比较而不是 latin1 字符串。
    assert.equal(mapped.fields.prompt, prompt);
    assert.equal(mapped.fields.size, '1792x1024');
    assert.equal(mapped.files.length, 2);
    assert.deepEqual(plain(mapped.files.map(file => file.source)), [dataUrl, jpegDataUrl]);

    const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
    const body = request.data.getBuffer();
    assert.equal((body.toString('latin1').match(/name="image"; filename="image-\d+"/g) || []).length, 2);
    assert.equal(body.toString('latin1').split(png.toString('latin1')).length - 1, 2);
    assert.ok(body.includes(Buffer.from('name="prompt"\r\n\r\n', 'utf8')));
    assert.ok(body.includes(Buffer.from(prompt, 'utf8')));
    // 上游 images/edits 不接受 messages，映射不能把 messages 带过去。
    assert.equal(body.includes(Buffer.from('name="messages"', 'utf8')), false);
});

test('OpenAI 风格 · 多个 text 段拼接，空段忽略', async () => {
    const mapped = await mapping.evaluate({
        messages: [{ role: 'user', content: [
            { type: 'text', text: '前半句' },
            { type: 'text', text: '  ' },
            { type: 'text', text: '后半句' }
        ] }]
    });
    const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
    assert.equal(plain(request.data).prompt, '前半句 后半句');
});

test('顶层 prompt/images 与 messages 混用时合并（模板优先）', async () => {
    const fromTemplate = await mapping.evaluate({
        prompt: '模板提示词', images: [dataUrl],
        messages: [{ role: 'user', content: [{ type: 'text', text: '消息提示词' }] }]
    });
    assert.equal(fromTemplate.fields.prompt, '模板提示词');
    assert.equal(fromTemplate.files.length, 1);

    // 顶层没有 images 时，参考图来自 messages 的 image_url 段
    const fromMessages = await mapping.evaluate({
        prompt: '模板提示词',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: jpegDataUrl } }] }]
    });
    assert.equal(fromMessages.files.length, 1);
    assert.equal(fromMessages.files[0].source, jpegDataUrl);
    const request = await buildPostOptions(channel.api_key, fromMessages, 'bearer');
    const body = request.data.getBuffer();
    assert.ok(body.includes(Buffer.from('name="prompt"\r\n\r\n', 'utf8')));
    assert.ok(body.includes(Buffer.from('模板提示词', 'utf8')));
});

test('参考图对象形式 {url} 也支持，空值被过滤', async () => {
    const mapped = await mapping.evaluate({
        prompt: 'x', messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: '' } },
            { type: 'image_url', image_url: { url: dataUrl } }
        ] }]
    });
    assert.equal(mapped.files.length, 1);
    assert.equal(mapped.files[0].source, dataUrl);

    const none = await mapping.evaluate({
        prompt: 'x', images: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]
    });
    assert.equal(none._route_path, '/v1/images/generations');
});

test('response_format 兼容字符串与对象，画幅换算与缺省值正确', async () => {
    assert.equal((await mapping.evaluate({ prompt: 'x', response_format: 'b64_json' })).response_format, 'b64_json');
    assert.equal((await mapping.evaluate({ prompt: 'x', response_format: { type: 'b64_json' } })).response_format, 'b64_json');
    assert.equal((await mapping.evaluate({ prompt: 'x' })).response_format, 'url');
    assert.equal((await mapping.evaluate({ prompt: 'x' })).quality, 'high');
    assert.equal((await mapping.evaluate({ prompt: 'x' })).n, 1);
    assert.equal((await mapping.evaluate({ prompt: 'x', n: 3, quality: 'low' })).n, 3);

    const ratios = { '16:9': '1792x1024', '9:16': '1024x1792', '1:1': '1024x1024', '4:3': '1536x1152', '3:4': '1152x1536' };
    for (const [size, expected] of Object.entries(ratios)) {
        assert.equal((await mapping.evaluate({ prompt: 'x', size })).size, expected, size);
    }
    assert.equal((await mapping.evaluate({ prompt: 'x' })).size, '1024x1024');
    assert.equal((await mapping.evaluate({ prompt: 'x', size: '2048x2048' })).size, '2048x2048');
});

test('文生图走上游 images/generations，且 response_format 一律是字符串', async () => {
    for (const response_format of ['url', { type: 'url' }, undefined]) {
        const mapped = await mapping.evaluate({ prompt: 'x', response_format });
        assert.equal(mapped._route_path, '/v1/images/generations', JSON.stringify(response_format));
        assert.equal(typeof mapped.response_format, 'string', JSON.stringify(response_format));
        assert.equal(mapped.response_format, 'url');
        // 上游 images/generations 是 OpenAI 图片接口：提示词在顶层 prompt，不传 messages。
        assert.equal(mapped.prompt, 'x');
        assert.equal('messages' in mapped, false);
    }
    // 上游 Go 结构体把 response_format.type 声明成 string，对象形式会被 400 拒绝。
    const mapped = await mapping.evaluate({ prompt: 'x', response_format: 'b64_json' });
    assert.equal(mapped.response_format, 'b64_json');
});

test('缺省参数必须补上：quality 强制 high，n 缺省 1，response_format 缺省 url', async () => {
    // 下游完全不带 quality / n / response_format
    const bare = await mapping.evaluate({ model: 'gpt-image-2', prompt: '一只猫' });
    assert.equal(bare.quality, 'high');
    assert.equal(bare.n, 1);
    assert.equal(bare.response_format, 'url');

    // quality 是空串 / null / 空白 都要补成 high（$exists 对 null 也算存在，必须显式判 null）
    for (const quality of ['', '   ', null, undefined]) {
        const mapped = await mapping.evaluate({ prompt: 'x', quality });
        assert.equal(mapped.quality, 'high', `quality=${JSON.stringify(quality)}`);
    }

    // 图生图分支同样要补
    const withImage = await mapping.evaluate({ prompt: 'x', images: [dataUrl] });
    assert.equal(withImage.fields.quality, 'high');
    assert.equal(withImage.fields.n, 1);
    assert.equal(withImage.fields.response_format, 'url');

    // response_format 的 null / 空对象也要回落 url
    for (const response_format of [null, {}, '', { type: null }, { type: '  ' }]) {
        const mapped = await mapping.evaluate({ prompt: 'x', response_format });
        assert.equal(mapped.response_format, 'url', `response_format=${JSON.stringify(response_format)}`);
    }

    // 显式给出的值必须保留
    const explicit = await mapping.evaluate({ prompt: 'x', quality: 'low', n: 3, response_format: 'b64_json' });
    assert.equal(explicit.quality, 'low');
    assert.equal(explicit.n, 3);
    assert.equal(explicit.response_format, 'b64_json');
});

test('历次发布的 req_mapping 都能正常解析，且与当前版本互不相同', async () => {
    // 同步脚本用这份名单判断「同源旧绑定」，必须保证每条都是合法 JSONata，
    // 否则脚本会在比较时静默失配，导致映射更新不上。
    assert.ok(legacy_req_mappings.length >= 2, '应至少记录两版历史映射');
    for (const [index, legacy] of legacy_req_mappings.entries()) {
        assert.notEqual(legacy, req_mapping, `v${index + 1} 不应与当前版本相同`);
        const compiled = jsonata(legacy);
        // 旧版本用最简请求即可求值，确认语法与引用都没问题。
        const mapped = await compiled.evaluate({ prompt: 'x', size: '1:1' });
        assert.equal(mapped.model, 'gpt-image-2', `v${index + 1}`);
    }
    // 历史版本必须是唯一的，避免重复记录
    assert.equal(new Set(legacy_req_mappings).size, legacy_req_mappings.length);
});

test('提交响应归一：url 模式给链接，b64_json 模式把 base64 放进 url', async () => {
    assert.deepEqual(plain(await response.evaluate({
        created: 1791167407,
        data: [{ url: 'https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/images/a.png' }]
    })), { model: 'gpt-image-2', url: 'https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/images/a.png' });

    assert.deepEqual(plain(await response.evaluate({
        created: 1791167407,
        choices: [{ message: { content: '![image_1](https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/images/b.png)' } }]
    })), { model: 'gpt-image-2', url: 'https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/images/b.png' });

    // response_format=b64_json 时上游只回 data[0].b64_json（没有 url）：
    // base64 必须放进下游唯一的 url 字段，否则下游只剩 { model, created }。
    const fromB64 = plain(await response.evaluate({
        created: 1791167407,
        data: [{ revised_prompt: '一只猫', b64_json: png.toString('base64'), width: 1024, height: 1024 }],
        usage: {}
    }));
    assert.deepEqual(fromB64, { model: 'gpt-image-2', url: png.toString('base64') });
});
