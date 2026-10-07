// 探测 https://img.688.qzz.io 对 gpt-image-2 的请求形态与返回结构（重点：图片是不是 base64）。
const axios = require('axios');
const FormData = require('form-data');
const zlib = require('zlib');

const BASE = 'https://img.688.qzz.io';
const KEY = 'sk-ywsrW6Ht3iNGbCH77ajWKN1zuX1jFu1ZlH5EoKtuHm1Pymnt';
const MODEL = 'gpt-image-2';
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

// 摘要：把超长 base64 折叠，保留字段形状与类型信息
const shape = data => {
    const walk = (value, depth) => {
        if (typeof value === 'string') {
            if (value.startsWith('data:image/')) return `<data-url len=${value.length}>`;
            if (/^[A-Za-z0-9+/=\s]{200,}$/.test(value)) return `<base64? len=${value.length} 前40=${value.slice(0, 40)}>`;
            if (value.length > 130) return value.slice(0, 130) + '…';
            return value;
        }
        if (Array.isArray(value)) return depth > 3 ? `<array len=${value.length}>` : value.map(item => walk(item, depth + 1));
        if (value && typeof value === 'object') {
            return depth > 3 ? '<object>' : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, depth + 1)]));
        }
        return value;
    };
    return JSON.stringify(walk(data, 0)).slice(0, 900);
};

async function attempt(label, fn) {
    const startedAt = Date.now();
    try {
        const response = await fn();
        console.log(`\n[${label}] HTTP ${response.status} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        console.log(`  ${shape(response.data)}`);
    } catch (error) {
        const status = error.response ? error.response.status : (error.code || 'n/a');
        const detail = error.response ? shape(error.response.data) : error.message;
        console.log(`\n[${label}] ERROR ${status} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        console.log(`  ${detail}`);
    }
}

(async () => {
    await attempt('1 chat/completions + response_format={type:url}', () => axios.post(`${BASE}/v1/chat/completions`, {
        model: MODEL, response_format: { type: 'url' }, size: '1024x1024', quality: 'low', n: 1,
        messages: [{ role: 'user', content: 'a small red circle on white background' }]
    }, { headers, timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity }));

    await attempt('2 images/generations + response_format="url"', () => axios.post(`${BASE}/v1/images/generations`, {
        model: MODEL, prompt: 'a small blue circle on white background', size: '1024x1024', quality: 'low', n: 1, response_format: 'url'
    }, { headers, timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity }));

    await attempt('3 images/generations 不带 response_format', () => axios.post(`${BASE}/v1/images/generations`, {
        model: MODEL, prompt: 'a small green circle on white background', size: '1024x1024', quality: 'low', n: 1
    }, { headers, timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity }));

    const png = makePng(64, 64, 30);
    await attempt('4 images/edits multipart', () => {
        const form = new FormData();
        form.append('model', MODEL);
        form.append('prompt', 'change background to solid yellow, keep subject');
        form.append('size', '1024x1024');
        form.append('quality', 'low');
        form.append('n', '1');
        form.append('image', png, { filename: 'image-1.png', contentType: 'image/png' });
        return axios.post(`${BASE}/v1/images/edits`, form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${KEY}` },
            timeout: 600000, maxContentLength: Infinity, maxBodyLength: Infinity
        });
    });
})();
