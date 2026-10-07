// 探测新上游 http://38.127.51.106:4599 对 gpt-image-2.5 支持的请求形态与返回结构。
// 用 low 质量、小尺寸，尽量低成本。逐项打印 HTTP 状态与可用的结果 URL。
const axios = require('axios');
const FormData = require('form-data');
const zlib = require('zlib');

const BASE = 'http://38.127.51.106:4599';
const KEY = process.env.PROBE_KEY || 'sk-F4LDJcn1b5s5JVB0gTHWS7Z75MIYMOmqIUYgmg6zzWTm9EaN';
const MODEL = 'gpt-image-2.5';
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

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

// 只打印有用的形状，不打印大 base64
const shape = data => {
    if (!data || typeof data !== 'object') return JSON.stringify(data).slice(0, 200);
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        if (k === 'data' && Array.isArray(v)) {
            out.data = v.map(item => {
                const entry = {};
                for (const [ik, iv] of Object.entries(item || {})) {
                    entry[ik] = typeof iv === 'string' && iv.startsWith('data:image/')
                        ? `<data-url ${iv.length} chars>`
                        : (typeof iv === 'string' && iv.length > 120 ? iv.slice(0, 120) + '…' : iv);
                }
                return entry;
            });
        } else if (k === 'choices' && Array.isArray(v)) {
            out.choices = v.map(c => ({ message: { content: typeof c?.message?.content === 'string' ? c.message.content.slice(0, 200) : c?.message?.content } }));
        } else if (typeof v === 'string' && v.length > 200) {
            out[k] = v.slice(0, 200) + '…';
        } else {
            out[k] = v;
        }
    }
    return JSON.stringify(out).slice(0, 700);
};

async function attempt(label, fn) {
    const startedAt = Date.now();
    try {
        const response = await fn();
        console.log(`\n[${label}] HTTP ${response.status} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        console.log(`  ${shape(response.data)}`);
    } catch (error) {
        const status = error.response ? error.response.status : 'n/a';
        const data = error.response ? error.response.data : error.message;
        console.log(`\n[${label}] ERROR ${status} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        console.log(`  ${shape(data)}`);
    }
}

(async () => {
    await attempt('5 chat/completions 不带 response_format', () => axios.post(`${BASE}/v1/chat/completions`, {
        model: MODEL, size: '1024x1024', quality: 'low', n: 1,
        messages: [{ role: 'user', content: 'a small purple circle on white background' }]
    }, { headers, timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity }));

    await attempt('6 images/generations 不带 quality/response_format', () => axios.post(`${BASE}/v1/images/generations`, {
        model: MODEL, prompt: 'a small orange circle on white background', n: 1
    }, { headers, timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity }));
})();
