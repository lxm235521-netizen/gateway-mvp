// 本地 mock 上游：模拟 https://img.688.qzz.io 的 gpt-image-2 可能返回的各种图片形态，
// 用于在没有可用上游额度时验证网关「响应侧 base64 -> 图床链接」的完整链路。
//
// 用法: node tools/mock-img688-upstream.js [port]
// 形态由 model 名区分（网关映射里 model 固定 gpt-image-2，这里用 prompt 关键字切换：
//   prompt 含 "dataurl"  -> chat/completions 的 content 是 data URL
//   prompt 含 "rawb64"   -> chat/completions 的 content 是裸 base64（Markdown 包装）
//   prompt 含 "openai"   -> 返回 OpenAI 风格 data[0].b64_json
//   prompt 含 "url"      -> 返回 data[0].url（http 链接）
//   其他                 -> 返回上游限流时的错误话术
const http = require('node:http');
const zlib = require('node:zlib');

const PORT = Number(process.argv[2] || 4599);
const KEY = 'sk-mock-688';

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        let value = (crc ^ buffer[index]) & 0xff;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        crc = (crc >>> 8) ^ value;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

// 生成一张足够大的渐变 PNG（压缩等级 0，保证 base64 长度远超裸 base64 判定门槛）。
function makePng(width, height) {
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
            raw[offset] = (x * 11) % 256;
            raw[offset + 1] = (y * 13) % 256;
            raw[offset + 2] = 190;
        }
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

const pngBase64 = makePng(32, 32).toString('base64');
const dataUrl = `data:image/png;base64,${pngBase64}`;

function readBody(req) {
    return new Promise(resolve => {
        let body = '';
        req.on('data', part => { body += part; });
        req.on('end', () => resolve(body));
    });
}

function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const body = await readBody(req);
    console.log(`[mock] ${req.method} ${url.pathname} auth=${(req.headers.authorization || '').slice(0, 14)}... body=${body.slice(0, 160).replace(/\s+/g, ' ')}`);

    if (req.headers.authorization !== `Bearer ${KEY}`) {
        return send(res, 401, { error: { message: 'bad key' } });
    }
    if (url.pathname === '/v1/models') {
        return send(res, 200, { object: 'list', success: true, data: [{ id: 'gpt-image-2', object: 'model' }] });
    }
    if (url.pathname === '/healthz') {
        return send(res, 200, { status: 'ok' });
    }

    const lower = body.toLowerCase();
    const wantDataUrl = lower.includes('dataurl');
    const wantRawB64 = lower.includes('rawb64');
    const wantOpenAi = lower.includes('openai');
    const wantUrl = lower.includes('wanturl');

    if (url.pathname === '/v1/chat/completions') {
        // 上游限流时就是这种 200 + 错误话术的响应
        if (!wantDataUrl && !wantRawB64 && !wantUrl) {
            return send(res, 200, {
                id: 'chatcmpl-mock', object: 'chat.completion', model: 'gpt-image-2',
                choices: [{ index: 0, message: { role: 'assistant', content: '由于我这边发生了错误，我未能生成图片。' }, finish_reason: 'stop' }]
            });
        }
        const content = wantUrl ? '![image_1](https://cdn.mock.local/generated/mock.png)'
            : (wantRawB64 ? `![image_1](${dataUrl})` : dataUrl);
        return send(res, 200, {
            id: 'chatcmpl-mock', object: 'chat.completion', model: 'gpt-image-2',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        });
    }

    if (url.pathname === '/v1/images/generations') {
        if (wantOpenAi) {
            return send(res, 200, { created: 1, data: [{ b64_json: pngBase64 }] });
        }
        if (wantDataUrl) {
            return send(res, 200, { created: 1, data: [{ url: dataUrl }] });
        }
        return send(res, 200, { created: 1, data: [{ url: 'https://cdn.mock.local/generated/mock.png' }] });
    }

    if (url.pathname === '/v1/images/edits') {
        // multipart，这里只回一个 data URL 结果
        return send(res, 200, { created: 1, data: [{ url: dataUrl }] });
    }

    return send(res, 404, { error: { message: `mock: unknown path ${url.pathname}` } });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`mock img688 upstream listening on http://0.0.0.0:${PORT} (key ${KEY}), png base64 length ${pngBase64.length}`);
});
