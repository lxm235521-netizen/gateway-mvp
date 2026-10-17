const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const jsonata = require('jsonata');
const {
    channel, channels, models, bindings, req_mapping, resp_mapping, legacy_req_mappings,
    BASE_URL, DEFAULT_API_KEY, LOGICAL_MODEL_NAME, UPSTREAM_MODEL_NAME, CHANNEL_NAME
} = require('../scripts/img688-gpt-image-2-config');
const klong = require('../scripts/klong-gpt-image-2-config');

// 复用 server.js 真实的 multipart 编码、上游 URL 解析与响应侧 base64 转换逻辑，
// 不发送任何真实生成请求（图床上传用假 responder 替换）。
const filename = path.resolve(__dirname, '../server.js');
const nativeRequire = createRequire(filename);

// 让 server.js 里的 axios.post 走假实现：既用于图床上传，也保证测试不会真的出网。
const imageBedUploads = [];
const axiosStub = {
    ...nativeRequire('axios'),
    post: async (url, data, options) => {
        if (url === 'https://files.mmg.lat/api/upload') {
            const buffer = data.getBuffer();
            imageBedUploads.push({ url, buffer, headers: data.getHeaders(), options });
            // Zipline 的默认回答是纯文本 URL（带 x-zipline-no-json 时）。
            return { data: `https://files.mmg.lat/u/uploaded-${imageBedUploads.length}.png` };
        }
        throw new Error(`unexpected axios.post ${url}`);
    },
    get: async url => { throw new Error(`unexpected axios.get ${url}`); }
};

const context = vm.createContext({
    require(name) {
        if (name === './db') return {};
        if (name === 'axios') return axiosStub;
        return nativeRequire(name);
    },
    module: { exports: {} }, __dirname: path.dirname(filename), process, console, Buffer, URL,
    setTimeout, clearTimeout
});
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
const buildPostOptions = vm.runInContext('buildPostOptions', context);
const resolveUpstreamUrl = vm.runInContext('resolveUpstreamUrl', context);
const tryConvertResponseImages = vm.runInContext('tryConvertResponseImages', context);
const convertMappedResponseImages = vm.runInContext('convertMappedResponseImages', context);
const looksLikeRawBase64 = vm.runInContext('looksLikeRawBase64', context);
const sniffImageExtension = vm.runInContext('sniffImageExtension', context);
const withTruthfulExtension = vm.runInContext('withTruthfulExtension', context);

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const png = Buffer.from(pngBase64, 'base64');
const dataUrl = `data:image/png;base64,${pngBase64}`;
// 真实图片解码后 base64 都会超过 looksLikeRawBase64 的长度门槛（128），
// 这里用未压缩的 24x24 渐变 PNG 造一段足够长的合法 base64。
const zlib = require('node:zlib');
function crc32(buffer) {
    let crc = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        let value = (crc ^ buffer[index]) & 0xff;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        crc = (crc >>> 8) ^ value;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}
function makeBigPng(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y += 1) {
        raw[y * (1 + width * 3)] = 0;
        for (let x = 0; x < width; x += 1) {
            const offset = y * (1 + width * 3) + 1 + x * 3;
            raw[offset] = x * 7;
            raw[offset + 1] = y * 5;
            raw[offset + 2] = 200;
        }
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}
const bigPngBase64 = makeBigPng(24, 24).toString('base64');
assert.ok(bigPngBase64.length > 300, '测试用图必须明显长于裸 base64 判定门槛');
const bigDataUrl = `data:image/png;base64,${bigPngBase64}`;
// 结构合法的最小 JPEG（1x1，SOI + APP0 + 量化表 + SOF0 + 扫描数据 + EOI），
// 专用于验证裸 base64 的扩展名嗅探会补 .jpg。
const jpegBase64 = [
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a',
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA',
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
].join('');
const mapping = jsonata(req_mapping);
const response = jsonata(resp_mapping);
const plain = value => JSON.parse(JSON.stringify(value));

const generationsUrl = `${BASE_URL}/v1/images/generations`;
const editsUrl = `${BASE_URL}/v1/images/edits`;

test('渠道定义指向 img.688.qzz.io，带 Bearer 密钥并开启响应侧 base64 转链接', () => {
    assert.equal(channels.length, 1);
    assert.equal(channel.name, 'gpt图片生成 688');
    assert.equal(channel.base_url, 'https://img.688.qzz.io');
    assert.equal(channel.auth_type, 'bearer');
    assert.equal(channel.status, 1);
    assert.equal(channel.api_key, DEFAULT_API_KEY);
    assert.match(channel.api_key, /^sk-/);
    assert.equal(channel.convert_resp_base64_to_url, 1);

    assert.equal(LOGICAL_MODEL_NAME, 'gpt-image-2');
    assert.equal(UPSTREAM_MODEL_NAME, 'gpt-image-2');
    assert.equal(CHANNEL_NAME, 'gpt图片生成 688');
    assert.equal(models[0].model_name, 'gpt-image-2');
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].model_name, 'gpt-image-2');
    assert.equal(bindings[0].route_path, '/v1/chat/completions');
    assert.equal(bindings[0].is_async, 0);
    assert.equal(bindings[0].proxy_content, 0);
    assert.equal(bindings[0].error_passthrough, 1);
    assert.equal(bindings[0].status, 1);
    assert.equal(bindings[0].poll_mapping, null);
});

test('请求映射与「gpt图片生成」/ Klong 逐字相同', () => {
    // 用户要求「请求方式和 gpt图片生成 渠道一样」，这里锁死这个约定：
    // 一旦改动本渠道的 req_mapping，该断言会失败，提示需要同步 klong 配置与同步脚本。
    assert.equal(req_mapping, klong.req_mapping);
    assert.ok(legacy_req_mappings.every(item => item !== req_mapping));
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
    for (const count of [1, 2]) {
        const mapped = await mapping.evaluate({
            model: 'gpt-image-2', prompt: '换成黄色背景', size: '1:1', images: Array(count).fill(dataUrl)
        });
        assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), editsUrl);
        const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
        const body = request.data.getBuffer().toString('latin1');
        assert.match(request.options.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.equal((body.match(/name="image"; filename="image-\d+"/g) || []).length, count);
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
        messages: [{ role: 'user', content: '生成一张真实摄影风格的城市夜景' }]
    });
    assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), generationsUrl);
    const request = await buildPostOptions(channel.api_key, mapped, 'bearer');
    assert.deepEqual(plain(request.data), {
        model: 'gpt-image-2',
        prompt: '生成一张真实摄影风格的城市夜景',
        size: '1792x1024',
        quality: 'high',
        n: 1,
        response_format: 'url'
    });
});

test('OpenAI 风格 · content 是 text+image_url 数组 -> 图生图并抽取参考图', async () => {
    const prompt = '参考这几张图片融合成城市夜景';
    const mapped = await mapping.evaluate({
        model: 'gpt-image-2',
        size: '1792x1024',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
                { type: 'image_url', image_url: { url: bigDataUrl } }
            ]
        }]
    });
    assert.equal(resolveUpstreamUrl({ base_url: channel.base_url }, mapped), editsUrl);
    assert.equal(mapped.fields.prompt, prompt);
    assert.deepEqual(plain(mapped.files.map(file => file.source)), [dataUrl, bigDataUrl]);
    const body = (await buildPostOptions(channel.api_key, mapped, 'bearer')).data.getBuffer().toString('latin1');
    // 上游 images/edits 不接受 messages
    assert.equal(body.includes('name="messages"'), false);
});

test('缺省参数补齐：quality=high、n=1、response_format=url，size 画幅换算', async () => {
    const bare = await mapping.evaluate({ model: 'gpt-image-2', prompt: '一只猫' });
    assert.equal(bare.quality, 'high');
    assert.equal(bare.n, 1);
    assert.equal(bare.response_format, 'url');
    assert.equal(bare.size, '1024x1024');

    for (const quality of ['', '   ', null]) {
        const mapped = await mapping.evaluate({ prompt: 'x', quality });
        assert.equal(mapped.quality, 'high', `quality=${JSON.stringify(quality)}`);
    }
    for (const response_format of [null, {}, '', { type: null }]) {
        const mapped = await mapping.evaluate({ prompt: 'x', response_format });
        assert.equal(mapped.response_format, 'url', `response_format=${JSON.stringify(response_format)}`);
    }

    const ratios = { '16:9': '1792x1024', '9:16': '1024x1792', '1:1': '1024x1024', '4:3': '1536x1152', '3:4': '1152x1536' };
    for (const [size, expected] of Object.entries(ratios)) {
        assert.equal((await mapping.evaluate({ prompt: 'x', size })).size, expected, size);
    }
    assert.equal((await mapping.evaluate({ prompt: 'x', size: '2048x2048' })).size, '2048x2048');
});

test('响应归一 · url 模式给链接，b64_json 模式把 base64 放进 url', async () => {
    assert.deepEqual(plain(await response.evaluate({
        created: 1791167407,
        data: [{ url: 'https://cdn.example.com/a.png' }]
    })), { model: 'gpt-image-2', url: 'https://cdn.example.com/a.png' });

    // response_format=b64_json：上游返回里根本没有 url，只有 data[0].b64_json。
    // 旧映射只取 data[0].url，下游会只剩 { model, created }；这里锁死 url 必须拿到 base64。
    assert.deepEqual(plain(await response.evaluate({
        created: 1791167407,
        data: [{ revised_prompt: '一只猫', b64_json: pngBase64, width: 1024, height: 1024 }]
    })), { model: 'gpt-image-2', url: pngBase64 });

    // 上游同时给 url 与 b64_json 时优先返回链接
    assert.equal((await response.evaluate({
        data: [{ url: 'https://cdn.example.com/a.png', b64_json: bigPngBase64 }]
    })).url, 'https://cdn.example.com/a.png');
});

test('响应归一 · chat/completions 的 Markdown 图片、data URL、裸 base64', async () => {
    assert.equal((await response.evaluate({
        choices: [{ message: { content: '![image_1](https://cdn.example.com/b.png)' } }]
    })).url, 'https://cdn.example.com/b.png');

    assert.equal((await response.evaluate({
        choices: [{ message: { content: dataUrl } }]
    })).url, pngBase64);

    assert.equal((await response.evaluate({
        choices: [{ message: { content: `![image_1](${bigDataUrl})` } }]
    })).url, bigPngBase64);

    assert.equal((await response.evaluate({
        choices: [{ message: { content: `\n  ${bigPngBase64}\n` } }]
    })).url, bigPngBase64);

    assert.equal((await response.evaluate({
        choices: [{ message: { content: [{ type: 'text', text: dataUrl }] } }]
    })).url, pngBase64);
});

test('响应归一 · 上游报错话术不会被当成图片链接', async () => {
    // 实测该上游限流时 chat/completions 会 200 + 「未能生成图片」的错误文本。
    for (const payload of [
        { choices: [{ message: { content: '由于我这边发生了错误，我未能生成图片。' } }] },
        { error: { message: 'rate limited' } },
        { choices: [{ message: { content: '请提供更多细节' } }] }
    ]) {
        assert.deepEqual(plain(await response.evaluate(payload)), { model: 'gpt-image-2', url: '' }, JSON.stringify(payload));
    }
});

test('响应归一 · image 包装、image_urls 与顶层 url 也被兼容', async () => {
    assert.equal((await response.evaluate({ image_urls: ['https://cdn.example.com/c.png'] })).url, 'https://cdn.example.com/c.png');
    assert.equal((await response.evaluate({ image: { url: 'https://cdn.example.com/d.png' } })).url, 'https://cdn.example.com/d.png');
    assert.equal((await response.evaluate({ image: { data: [{ b64_json: pngBase64 }] } })).url, pngBase64);
    // 顶层裸 url 不在归一范围内，避免把错误体的 url 字段当成图片
    assert.equal((await response.evaluate({ url: 'https://cdn.example.com/e.png' })).url, '');
});

test('响应侧 base64 -> 图床链接：data URL、裸 base64、Markdown 图片', async () => {
    const binding = { convert_resp_base64_to_url: 1 };

    // 映射后的响应里 data URL 已经剥掉 markdown 包装，这里三种形态都要能换成链接。
    for (const [label, payload] of [
        ['data url', { model: 'gpt-image-2', url: bigDataUrl, b64_json: bigPngBase64 }],
        ['裸 base64', { model: 'gpt-image-2', url: bigPngBase64 }],
        ['jpeg 裸 base64', { model: 'gpt-image-2', url: jpegBase64 }],
        ['markdown 里的 data url', { model: 'gpt-image-2', url: `![x](${bigDataUrl})` }]
    ]) {
        const before = imageBedUploads.length;
        const converted = await tryConvertResponseImages(payload, binding);
        assert.ok(imageBedUploads.length > before, `${label} 应触发图床上传`);
        assert.match(converted.url, /^https:\/\/files\.mmg\.lat\/u\/uploaded-\d+\.png$/, label);
    }

    // 同时带 url 与 b64_json 时两个字段都会被换成链接
    const both = await tryConvertResponseImages({ url: bigDataUrl, b64_json: bigPngBase64 }, binding);
    assert.match(both.url, /^https:\/\/files\.mmg\.lat\/u\/uploaded-\d+\.png$/);
    assert.match(both.b64_json, /^https:\/\/files\.mmg\.lat\/u\/uploaded-\d+\.png$/);
});

test('图床上传使用 multipart 与鉴权头', async () => {
    const before = imageBedUploads.length;
    await tryConvertResponseImages({ url: bigDataUrl }, { convert_resp_base64_to_url: 1 });
    assert.equal(imageBedUploads.length, before + 1);
    const upload = imageBedUploads.at(-1);

    // Zipline 需要 Authorization 头带 zk_ 前缀的 key，并要求 multipart 的 file 字段。
    const requestHeaders = upload.options.headers;
    assert.ok(requestHeaders['content-type'] && /multipart\/form-data/i.test(requestHeaders['content-type']), 'multipart content-type');
    const authHeader = Object.keys(requestHeaders).find(name => name.toLowerCase() === 'authorization');
    assert.ok(authHeader, 'Authorization 头必须存在');
    assert.match(String(requestHeaders[authHeader]), /^zk_/, 'Authorization 头带 zk_ 前缀的 key');
    assert.equal(requestHeaders['x-zipline-no-json'], 'true', '默认要求纯文本回答');

    // 请求侧开关（convert_base64_to_url）用的是同一个上传函数。
    const formBody = upload.buffer.toString('latin1');
    assert.ok(formBody.includes('name="file"'), '表单字段名必须是 file');
    assert.ok(formBody.includes('image/png'), '必须带真实的 content-type');
});

test('扩展名嗅探：图床链接已带扩展名时不重复拼接', () => {
    // 图床对所有上传都返回 .png 链接，因此 withTruthfulExtension 在链接已带扩展名时保持原样。
    assert.equal(sniffImageExtension(jpegBase64.replace(/\s/g, '')), 'jpg');
    assert.equal(sniffImageExtension('R0lGOD' + 'A'.repeat(200)), 'gif');
    assert.equal(sniffImageExtension('UklGR' + 'A'.repeat(200)), 'webp');
    assert.equal(sniffImageExtension(bigPngBase64), 'png');
    assert.equal(withTruthfulExtension('https://cdn.example.com/a.png', bigPngBase64), 'https://cdn.example.com/a.png');
    assert.equal(withTruthfulExtension('https://files.mmg.lat/u/x', jpegBase64.replace(/\s/g, '')), 'https://files.mmg.lat/u/x.jpg');
    assert.equal(withTruthfulExtension('https://files.mmg.lat/u/x?token=1', jpegBase64.replace(/\s/g, '')), 'https://files.mmg.lat/u/x.jpg?token=1');
    assert.equal(withTruthfulExtension('data:image/png;base64,AAAA', bigPngBase64), 'data:image/png;base64,AAAA');
});

test('响应侧转换：http 链接原样保留，开关关闭时不做任何事', async () => {
    const httpUrl = 'https://cdn.example.com/a.png';
    const kept = await tryConvertResponseImages({ url: httpUrl, b64_json: null }, { convert_resp_base64_to_url: 1 });
    assert.equal(kept.url, httpUrl);

    const before = imageBedUploads.length;
    const untouched = await tryConvertResponseImages({ url: bigDataUrl }, { convert_resp_base64_to_url: 0 });
    assert.equal(untouched.url, bigDataUrl);
    assert.equal(imageBedUploads.length, before);
});

test('响应侧转换：图床失败时保留上游原始返回，不把成功请求变成错误', async () => {
    const brokenAxios = { ...axiosStub, post: async () => ({ data: { success: false } }) };
    const brokenContext = vm.createContext({
        require(name) {
            if (name === './db') return {};
            if (name === 'axios') return brokenAxios;
            return nativeRequire(name);
        },
        module: { exports: {} }, __dirname: path.dirname(filename), process, console, Buffer, URL,
        setTimeout, clearTimeout
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), brokenContext, { filename });
    const convertBroken = vm.runInContext('tryConvertResponseImages', brokenContext);
    const payload = { model: 'gpt-image-2', url: dataUrl, b64_json: pngBase64 };
    const result = await convertBroken(payload, { convert_resp_base64_to_url: 1 });
    assert.deepEqual(plain(result), plain(payload));
});

test('裸 base64 判定只看约定的字段名，避免把普通长文本当图片上传', () => {
    // JPEG 夹具本身要合法：SOI 开头、长度过门槛、是标准 base64
    assert.equal(jpegBase64.startsWith('/9j/'), true, 'JPEG 夹具必须是 SOI 开头');
    assert.equal(jpegBase64.length >= 128, true, `JPEG 夹具长度 ${jpegBase64.length}`);
    assert.equal(/^[A-Za-z0-9+/]+={0,2}$/.test(jpegBase64), true, 'JPEG 夹具必须是合法 base64');
    assert.equal(looksLikeRawBase64(jpegBase64, 'url'), true);
    assert.equal(looksLikeRawBase64(bigPngBase64, 'b64_json'), true);
    assert.equal(looksLikeRawBase64(bigPngBase64, 'url'), true);
    assert.equal(looksLikeRawBase64(bigPngBase64, 'prompt'), false);
    assert.equal(looksLikeRawBase64('a'.repeat(500), 'prompt'), false);
    assert.equal(looksLikeRawBase64('短', 'url'), false);
    // 换行/空格会被忽略（真实 base64 常按 76 列折行）
    const folded = 'A'.repeat(200) + '\n' + 'B'.repeat(100) + '  ' + 'C'.repeat(40);
    assert.equal(looksLikeRawBase64(folded, 'b64_json'), true, `folded len=${folded.replace(/\s/g, '').length}`);
    // http 链接与错误话术都不是裸 base64
    assert.equal(looksLikeRawBase64('https://cdn.example.com/a.png', 'url'), false);
    assert.equal(looksLikeRawBase64('由于我这边发生了错误，我未能生成图片', 'content'), false);
    // 带 base64 补位的字符串同样要能识别
    assert.equal(looksLikeRawBase64('A'.repeat(300) + '==', 'b64_json'), true);
});

test('convertMappedResponseImages 递归处理数组与嵌套对象', async () => {
    const converted = await convertMappedResponseImages({
        data: [{ url: bigDataUrl, nested: { b64_json: bigPngBase64 } }],
        other: 'plain text'
    });
    assert.match(converted.data[0].url, /^https:\/\/files\.mmg\.lat\/u\/uploaded-\d+\.png$/);
    assert.match(converted.data[0].nested.b64_json, /^https:\/\/files\.mmg\.lat\/u\/uploaded-\d+\.png$/);
    assert.equal(converted.other, 'plain text');
});

test('历史请求映射清单可用于同源判断', async () => {
    for (const legacy of legacy_req_mappings) {
        assert.notEqual(legacy, req_mapping);
        const compiled = jsonata(legacy);
        const mapped = await compiled.evaluate({ prompt: 'x', size: '1:1' });
        assert.equal(mapped.model, 'gpt-image-2');
    }
    assert.equal(new Set(legacy_req_mappings).size, legacy_req_mappings.length);
});
