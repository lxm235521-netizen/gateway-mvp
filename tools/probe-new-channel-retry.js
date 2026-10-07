// 小样本重试：确认 gpt-image-2.5 新渠道 #23 到底是"映射不兼容"还是"上游偶发超时"。
// 只打新渠道，用 low 质量 + 1:1（比 1792x1024 轻），逐次打印耗时与结果。
const axios = require('axios');
const zlib = require('zlib');

const BASE = 'http://38.127.51.106:4599';
const KEY = 'sk-F4LDJcn1b5s5JVB0gTHWS7Z75MIYMOmqIUYgmg6zzWTm9EaN';
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ROUNDS = Number(process.argv[2] || 3);

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

async function call(label, body) {
    const startedAt = Date.now();
    try {
        const response = await axios.post(`${BASE}/v1/images/generations`, body, {
            headers, timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity
        });
        const url = response.data?.data?.[0]?.url || '';
        console.log(`  [${label}] ✓ 200 (${Math.round((Date.now() - startedAt) / 1000)}s) ${url.slice(0, 88)}`);
        return true;
    } catch (error) {
        const status = error.response ? error.response.status : (error.code || 'n/a');
        const detail = error.response ? JSON.stringify(error.response.data).slice(0, 160) : error.message;
        console.log(`  [${label}] ✗ ${status} (${Math.round((Date.now() - startedAt) / 1000)}s) ${detail}`);
        return false;
    }
}

(async () => {
    const png = 'data:image/png;base64,' + makePng(64, 64, 11).toString('base64');
    let ok = 0;
    let fail = 0;

    for (let i = 1; i <= ROUNDS; i += 1) {
        const success = await call(`小尺寸 1:1 第${i}次`, {
            model: 'gpt-image-2.5', prompt: `a small ${i % 2 ? 'red' : 'blue'} circle on white background`,
            size: '1024x1024', quality: 'low', n: 1, response_format: 'url'
        });
        success ? (ok += 1) : (fail += 1);
    }

    // 用户 curl 的实际尺寸 1792x1024，单独试一次
    const big = await call('1792x1024 第1次', {
        model: 'gpt-image-2.5', prompt: '生成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影',
        size: '1792x1024', quality: 'low', n: 1, response_format: 'url'
    });
    big ? (ok += 1) : (fail += 1);

    // 图生图（multipart edits 已由映射脚本验证，这里直接验证上游对该尺寸的接受度）
    console.log(`\n小计: ok=${ok} fail=${fail}`);
})();
