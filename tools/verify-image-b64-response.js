// 端到端校验图片接口的 response_format 返回方式（gpt-image-2 / gpt-image-2.5）。
//
// 下游契约固定为 { "model": ..., "url": ... }：
//   - response_format=url      -> url 是 http 链接；
//   - response_format=b64_json -> url 是裸 base64（上游 b64 响应里没有 url 字段，
//     旧映射会让 url 变 undefined，下游只剩 { model, created }）。
// 本脚本经网关真实调用一次 b64_json、一次 url，断言两种返回都能从 url 拿到图。
//
// 用法（在宿主机执行，会发起真实生成请求，按图片计费）：
//   node tools/verify-image-b64-response.js [网关地址] [网关密钥] [模型1,模型2]
// 默认网关地址 http://127.0.0.1:3009，默认模型 gpt-image-2,gpt-image-2.5。
// 退出码 0 表示全部通过；1 表示有失败项或请求失败。
const axios = require('axios');

const baseUrl = (process.argv[2] || 'http://127.0.0.1:3009').replace(/\/+$/, '');
const gatewayKey = process.argv[3] || 'sk-test-key-123';
const models = (process.argv[4] || 'gpt-image-2,gpt-image-2.5').split(',').map(name => name.trim()).filter(Boolean);
const headers = { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_SIGNATURE = Buffer.from('RIFF', 'ascii');

const results = [];
function record(name, passed, detail) {
    results.push({ name, passed });
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// 真实图片的 base64 解码后应带 PNG / JPEG / WEBP 魔数，避免把错误文本当成功。
function decodeImageHead(base64) {
    if (typeof base64 !== 'string' || base64.length < 128) return null;
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { format: 'png', bytes: buffer.length };
    if (buffer.subarray(0, 3).equals(JPEG_SIGNATURE)) return { format: 'jpeg', bytes: buffer.length };
    if (buffer.subarray(0, 4).equals(WEBP_SIGNATURE)) return { format: 'webp', bytes: buffer.length };
    return null;
}

async function generate(model, responseFormat) {
    const startedAt = Date.now();
    const response = await axios.post(`${baseUrl}/v1/images/generations`, {
        model,
        prompt: 'a red dot on white background',
        size: '1:1',
        quality: 'low',
        n: 1,
        response_format: responseFormat
    }, { headers, timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity });
    return { body: response.data, ms: Date.now() - startedAt };
}

async function checkB64(model) {
    const { body, ms } = await generate(model, 'b64_json');
    record(`${model} b64_json · 只返回 model + url 两个字段`,
        JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['model', 'url']),
        `keys=${Object.keys(body).join(',')}`);
    record(`${model} b64_json · url 是 base64 且可解码成图片`,
        Boolean(decodeImageHead(body.url)),
        decodeImageHead(body.url) ? `${decodeImageHead(body.url).format} ${decodeImageHead(body.url).bytes}B, len=${body.url.length}, ${ms}ms`
            : `url=${String(body.url).slice(0, 80)}`);
    record(`${model} b64_json · model 正确`, body.model === model, `model=${body.model}`);
}

async function checkUrl(model) {
    const { body, ms } = await generate(model, 'url');
    record(`${model} url · url 是 http 链接`, typeof body.url === 'string' && /^https?:\/\//.test(body.url),
        typeof body.url === 'string' ? `${body.url.slice(0, 60)}… ${ms}ms` : `url=${JSON.stringify(body.url)}`);
    record(`${model} url · model 正确`, body.model === model, `model=${body.model}`);
}

(async () => {
    console.log(`gateway=${baseUrl} models=${models.join(',')}`);
    for (const model of models) {
        try {
            await checkB64(model);
        } catch (error) {
            record(`${model} b64_json · 请求成功`, false, error.response ? `HTTP ${error.response.status} ${JSON.stringify(error.response.data).slice(0, 200)}` : error.message);
        }
        try {
            await checkUrl(model);
        } catch (error) {
            record(`${model} url · 请求成功`, false, error.response ? `HTTP ${error.response.status} ${JSON.stringify(error.response.data).slice(0, 200)}` : error.message);
        }
    }

    const failed = results.filter(item => !item.passed);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    if (failed.length) {
        console.log('失败项：');
        failed.forEach(item => console.log(`  - ${item.name}`));
        process.exitCode = 1;
    }
})();
