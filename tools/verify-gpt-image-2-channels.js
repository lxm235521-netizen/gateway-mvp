// 逐渠道验证 gpt-image-2 对指定请求形态的兼容性。
// 做法：每次只启用一个绑定（其余临时置 status=0），跑完恢复原状。
// ⚠ 会临时改动 model_bindings.status，脚本结束（含异常）时一定会还原。
//
// 用法：node tools/verify-gpt-image-2-channels.js <gatewayBaseUrl> <gatewayKey>
const axios = require('axios');

const baseUrl = process.argv[2] || 'http://154.44.9.233:3009';
const gatewayKey = process.argv[3] || 'sk-test-key-123';
const headers = { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' };

process.env.DB_HOST = process.env.DB_HOST || '154.36.173.77';
process.env.DB_PORT = process.env.DB_PORT || '3310';
process.env.DB_NAME = process.env.DB_NAME || 'gateway';
process.env.DB_USER = process.env.DB_USER || 'gateway';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'gateway-password';
const db = require('../db');

const PROMPT = '生成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影';
const IMG_PROMPT = '参考这几张图片，将主体融合成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影';

// 形态 1：用户给的 curl 文生图（/v1/chat/completions + messages 字符串）
const textToImageMessages = {
    model: 'gpt-image-2',
    response_format: { type: 'url' },
    size: '1792x1024', quality: 'high', n: 1,
    messages: [{ role: 'user', content: PROMPT }]
};

// 形态 2：用户给的 curl 图生图（/v1/chat/completions + content 数组带 image_url）
const imageToOneMessages = pngDataUrl => ({
    model: 'gpt-image-2',
    size: '1792x1024', quality: 'high', n: 1,
    messages: [{
        role: 'user',
        content: [
            { type: 'text', text: IMG_PROMPT },
            { type: 'image_url', image_url: { url: pngDataUrl } }
        ]
    }]
});

// 形态 3/4：网关统一模板（作为对照，确认渠道本身至少是通的）
const unifiedText = { model: 'gpt-image-2', prompt: PROMPT, size: '16:9', quality: 'low', n: 1 };
const unifiedImage = pngDataUrl => ({ model: 'gpt-image-2', prompt: IMG_PROMPT, size: '16:9', quality: 'low', n: 1, images: [pngDataUrl] });

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

async function call(label, path, payload) {
    const startedAt = Date.now();
    try {
        const response = await axios.post(baseUrl + path, payload, {
            headers, timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity
        });
        const body = response.data || {};
        const url = typeof body.url === 'string' ? body.url : '';
        const host = url.startsWith('data:image/') ? 'data-url' : (url ? new URL(url).host : '(空)');
        console.log(`    [${label}] ✓ HTTP ${response.status} (${Math.round((Date.now() - startedAt) / 1000)}s) keys=${Object.keys(body).join(',')} url=${host}`);
        return true;
    } catch (error) {
        const status = error.response ? error.response.status : 'n/a';
        const detail = JSON.stringify(error.response ? error.response.data : error.message).slice(0, 220);
        console.log(`    [${label}] ✗ ${status} (${Math.round((Date.now() - startedAt) / 1000)}s) ${detail}`);
        return false;
    }
}

(async () => {
    const pngDataUrl = 'data:image/png;base64,' + makePng(64, 64, 42).toString('base64');

    const bindings = await db.all(
        `SELECT b.id, b.channel_id, b.status, c.name AS channel, c.base_url
         FROM model_bindings b
         JOIN channels c ON c.id = b.channel_id
         JOIN logical_models lm ON lm.id = b.logical_model_id
         WHERE lm.model_name = 'gpt-image-2'
         ORDER BY b.id`
    );
    const original = bindings.map(b => ({ id: b.id, status: Number(b.status) }));
    console.log('原始绑定状态: ' + original.map(o => `#${o.id}=${o.status}`).join(' '));

    try {
        for (const binding of bindings) {
            console.log(`\n=== 渠道 #${binding.channel_id} ${binding.channel} (${binding.base_url}) 绑定 #${binding.id} 原status=${binding.status} ===`);
            for (const other of bindings) {
                await db.run('UPDATE model_bindings SET status = ? WHERE id = ?', [other.id === binding.id ? 1 : 0, other.id]);
            }
            await call('形态A 用户curl 文生图 (/v1/chat/completions)', '/v1/chat/completions', textToImageMessages);
            await call('形态B 用户curl 图生图 (/v1/chat/completions)', '/v1/chat/completions', imageToOneMessages(pngDataUrl));
            await call('对照C 统一模板 文生图', '/v1/images/generations', unifiedText);
            await call('对照D 统一模板 图生图', '/v1/images/edits', unifiedImage(pngDataUrl));
        }
    } finally {
        for (const item of original) {
            await db.run('UPDATE model_bindings SET status = ? WHERE id = ?', [item.status, item.id]);
        }
        const after = await db.all(
            `SELECT b.id, b.status FROM model_bindings b JOIN logical_models lm ON lm.id = b.logical_model_id WHERE lm.model_name = 'gpt-image-2' ORDER BY b.id`
        );
        console.log('\n已还原绑定状态: ' + after.map(o => `#${o.id}=${o.status}`).join(' '));
        await db.pool.end();
    }
})();
