// 端到端验证 gpt-image-2.5：经网关调用，按返回的图片域名判断请求落在哪个渠道。
// 旧渠道 #15 (154.9.235.100:3099) 与新渠道 #23 (38.127.51.106:4599) 的图床域名不同，
// 因此可以直接从 url 判断实际路由到了哪一边。
// 用法：node tools/verify-gpt-image-25.js <gatewayBaseUrl> <gatewayKey> [rounds]
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

const baseUrl = process.argv[2] || 'http://154.44.9.233:3009';
const gatewayKey = process.argv[3] || 'sk-test-key-123';
const rounds = Number(process.argv[4] || 6);
const headers = { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' };

// 新渠道图床是 open.kcai.asia，旧渠道另有一批域名；用域名归类便于观察分流。
const channelOf = url => {
    if (!url) return 'none';
    if (url.includes('open.kcai.asia')) return '新渠道 #23 (38.127.51.106:4599)';
    if (url.startsWith('data:image/')) return 'data-url';
    return `其他/旧渠道 (${new URL(url).host})`;
};

const results = {};

async function post(label, path, payload) {
    const startedAt = Date.now();
    try {
        const response = await axios.post(baseUrl + path, payload, {
            headers, timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity
        });
        const body = response.data || {};
        const url = typeof body.url === 'string' ? body.url : '';
        const which = channelOf(url);
        results[which] = (results[which] || 0) + 1;
        console.log(`[${label}] HTTP ${response.status} (${Math.round((Date.now() - startedAt) / 1000)}s) keys=${Object.keys(body).join(',')}`);
        console.log(`   路由 -> ${which}`);
        console.log(`   url = ${url.startsWith('data:image/') ? `data-url(${url.length})` : (url || '(空)')}`);
        console.log(`   b64_json 存在: ${body.b64_json !== undefined && body.b64_json !== null}`);
        if (body.data) console.log(`   data[0].url = ${body.data[0] && body.data[0].url}`);
    } catch (error) {
        const status = error.response ? error.response.status : 'n/a';
        console.log(`[${label}] ERROR ${status} (${Math.round((Date.now() - startedAt) / 1000)}s): ${JSON.stringify(error.response ? error.response.data : error.message).slice(0, 300)}`);
    }
}

(async () => {
    const png = makePng(64, 64, 42);
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');

    for (let round = 1; round <= rounds; round += 1) {
        await post(`R${round} 统一模板 文生图`, '/v1/images/generations', {
            model: 'gpt-image-2.5', prompt: `a small ${round % 2 ? 'red' : 'blue'} circle on white background`,
            size: '1:1', quality: 'low', n: 1
        });
    }
    await post('统一模板 图生图', '/v1/images/edits', {
        model: 'gpt-image-2.5', prompt: 'change background to solid yellow, keep subject',
        size: '1:1', quality: 'low', n: 1, images: [dataUrl]
    });
    await post('messages 风格 文生图', '/v1/chat/completions', {
        model: 'gpt-image-2.5', response_format: { type: 'url' }, size: '1:1', quality: 'low', n: 1,
        messages: [{ role: 'user', content: 'a small green circle on white background' }]
    });
    await post('messages 风格 图生图', '/v1/chat/completions', {
        model: 'gpt-image-2.5', size: '1:1', quality: 'low', n: 1,
        messages: [{ role: 'user', content: [
            { type: 'text', text: 'change background to solid purple, keep subject' },
            { type: 'image_url', image_url: { url: dataUrl } }
        ] }]
    });

    console.log(`\n分流统计: ${JSON.stringify(results, null, 2)}`);
})();
