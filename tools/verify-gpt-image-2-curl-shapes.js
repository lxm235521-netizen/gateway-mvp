// 验证用户给的两条 curl 形态：经网关实际调用（仅 #20 YuanAI 启用，路由确定）。
// 用 low 质量、1:1 尺寸控制成本。用法：node tools/verify-gpt-image-2-curl-shapes.js <网关> <key>
const axios = require('axios');
const zlib = require('zlib');

const baseUrl = process.argv[2] || 'http://154.44.9.233:3009';
const gatewayKey = process.argv[3] || 'sk-test-key-123';
const headers = { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' };

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

async function call(label, payload) {
    const startedAt = Date.now();
    try {
        const response = await axios.post(`${baseUrl}/v1/chat/completions`, payload, {
            headers, timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity
        });
        const body = response.data || {};
        const url = typeof body.url === 'string' ? body.url : '';
        const target = url.startsWith('data:image/') ? `data-url(${url.length})` : (url ? new URL(url).host : '(空)');
        console.log(`[${label}] ✓ HTTP ${response.status} (${Math.round((Date.now() - startedAt) / 1000)}s) keys=${Object.keys(body).join(',')}`);
        console.log(`    model=${body.model} url=${target}`);
    } catch (error) {
        const status = error.response ? error.response.status : 'n/a';
        console.log(`[${label}] ✗ ${status} (${Math.round((Date.now() - startedAt) / 1000)}s) ${JSON.stringify(error.response ? error.response.data : error.message).slice(0, 300)}`);
    }
}

(async () => {
    const png1 = 'data:image/png;base64,' + makePng(64, 64, 11).toString('base64');
    const png2 = 'data:image/jpeg;base64,' + makePng(64, 64, 77).toString('base64');

    await call('文生图 curl（messages 字符串）', {
        model: 'gpt-image-2',
        response_format: { type: 'url' },
        size: '1792x1024',
        quality: 'low',
        n: 1,
        messages: [{ role: 'user', content: '生成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影' }]
    });

    await call('图生图 curl（content 数组 + 2 张 image_url）', {
        model: 'gpt-image-2',
        size: '1792x1024',
        quality: 'low',
        n: 1,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: '参考这几张图片，将主体融合成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影' },
                { type: 'image_url', image_url: { url: png1 } },
                { type: 'image_url', image_url: { url: png2 } }
            ]
        }]
    });
})();
