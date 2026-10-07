// 对照测试：同一个 gpt-image-2 逻辑模型，分别用「网关统一模板」和「用户给的 OpenAI 风格」请求，
// 打到指定网关（本地容器或远端部署），对比结果。
// 用法：node tools/verify-klong-formats.js <gatewayBaseUrl> <gatewayKey>
const axios = require('axios');
const zlib = require('zlib');

function crc32(buf) {
    let crc = 0xffffffff;
    for (let n = 0; n < buf.length; n += 1) {
        let c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function makePng(w, h, seed) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc(h * (1 + w * 3));
    for (let y = 0; y < h; y += 1) {
        raw[y * (1 + w * 3)] = 0;
        for (let x = 0; x < w; x += 1) {
            const o = y * (1 + w * 3) + 1 + x * 3;
            raw[o] = (x + seed) % 256;
            raw[o + 1] = (y + seed * 2) % 256;
            raw[o + 2] = (128 + seed) % 256;
        }
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
}

const baseUrl = process.argv[2] || 'http://127.0.0.1:3009';
const gatewayKey = process.argv[3] || 'sk-test-key-123';

async function post(label, path, payload) {
    const startedAt = Date.now();
    try {
        const response = await axios.post(baseUrl + path, payload, {
            headers: { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' },
            timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity
        });
        const body = response.data || {};
        const url = typeof body.url === 'string' ? body.url : '';
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[${label}] HTTP ${response.status} (${elapsed}s) keys=${Object.keys(body).join(',')} model=${body.model}`);
        console.log(`         url=${url.startsWith('data:image/') ? `data-url(${url.length})` : url || '(空)'}`);
    } catch (error) {
        const status = error.response ? error.response.status : 'n/a';
        const detail = error.response ? JSON.stringify(error.response.data).slice(0, 260) : error.message;
        console.log(`[${label}] ERROR ${status} (${Math.round((Date.now() - startedAt) / 1000)}s): ${detail}`);
    }
}

(async () => {
    console.log(`target: ${baseUrl}\n`);
    const png1 = makePng(64, 64, 20).toString('base64');
    const png2 = makePng(64, 64, 90).toString('base64');

    await post('A 统一模板 文生图', '/v1/images/generations', {
        model: 'gpt-image-2', prompt: '一张真实摄影风格的城市夜景，电影感', size: '16:9', quality: 'low', n: 1
    });

    await post('B 统一模板 图生图', '/v1/images/edits', {
        model: 'gpt-image-2', prompt: '参考这张图，融合成城市夜景', size: '16:9', quality: 'low', n: 1,
        images: ['data:image/png;base64,' + png1]
    });

    await post('C 用户的 curl 文生图', '/v1/chat/completions', {
        model: 'gpt-image-2',
        response_format: { type: 'url' },
        size: '1792x1024', quality: 'high', n: 1,
        messages: [{ role: 'user', content: '生成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影' }]
    });

    await post('D 用户的 curl 图生图', '/v1/chat/completions', {
        model: 'gpt-image-2',
        size: '1792x1024', quality: 'high', n: 1,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: '参考这几张图片，将主体融合成一张真实摄影风格的城市夜景' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png1 } },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + png2 } }
            ]
        }]
    });

    // 不带 quality：网关必须补成 high（上游按 medium 计费/出图，这里只验证请求被接受）
    await post('E 不带 quality（网关补 high）', '/v1/images/generations', {
        model: 'gpt-image-2', prompt: '一张真实摄影风格的城市夜景，电影感', size: '16:9', n: 1
    });

    // quality 传 null：也必须补成 high，不能把 null 透传给上游
    await post('F quality=null（网关补 high）', '/v1/images/generations', {
        model: 'gpt-image-2', prompt: '一张真实摄影风格的城市夜景，电影感', size: '16:9', quality: null, n: 1
    });
})();
