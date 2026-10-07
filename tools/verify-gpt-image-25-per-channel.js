// 逐渠道直接验证 gpt-image-2.5 对用户两条 curl 形态的兼容性。
//
// 做法：从库里读每个绑定的 req_mapping/resp_mapping，用 server.js 真实逻辑把用户
// 的 curl 请求体映射成上游请求，直接发给该渠道上游（不经网关、不改任何生产状态）。
// 这样每个渠道都能确定性验证，且用 low 质量控制成本。
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const zlib = require('zlib');

const filename = path.resolve(__dirname, '../server.js');
const nativeRequire = createRequire(filename);
const db = nativeRequire('./db');
const context = vm.createContext({
    require(name) { return name === './db' ? {} : nativeRequire(name); },
    module: { exports: {} }, __dirname: path.dirname(filename), process, console, Buffer, URL
});
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
const executeMapping = vm.runInContext('executeMapping', context);
const buildPostOptions = vm.runInContext('buildPostOptions', context);
const resolveUpstreamUrl = vm.runInContext('resolveUpstreamUrl', context);

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

const summarize = value => {
    if (typeof value === 'string' && value.startsWith('data:image/')) return `<data-url ${value.length} chars>`;
    if (Array.isArray(value)) return value.map(summarize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v)]));
    return value;
};

// 只打印有用的形状，避免刷屏
const shape = data => {
    if (!data || typeof data !== 'object') return JSON.stringify(data).slice(0, 200);
    if (data.error) return JSON.stringify(data.error).slice(0, 260);
    const url = data?.data?.[0]?.url || data?.url;
    return `data[0].url=${typeof url === 'string' ? url.slice(0, 90) : JSON.stringify(url)}`;
};

async function runForBinding(binding, label, payload) {
    const mapped = await executeMapping(binding.req_mapping, payload);
    const upstreamUrl = resolveUpstreamUrl(binding, mapped);
    console.log(`\n  [${label}] 映射后请求：`);
    console.log(`    ${JSON.stringify(summarize(mapped)).slice(0, 400)}`);
    console.log(`    上游: POST ${upstreamUrl}`);

    const postRequest = await buildPostOptions(binding.api_key || binding.channel_api_key, mapped, binding.channel_auth_type);
    const startedAt = Date.now();
    try {
        const response = await nativeRequire('axios').post(upstreamUrl, postRequest.data, {
            headers: postRequest.options.headers,
            timeout: 900000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log(`    ✓ HTTP ${response.status} (${Math.round((Date.now() - startedAt) / 1000)}s) ${shape(response.data)}`);
        return true;
    } catch (error) {
        const status = error.response ? error.response.status : 'n/a';
        console.log(`    ✗ ${status} (${Math.round((Date.now() - startedAt) / 1000)}s) ${shape(error.response ? error.response.data : error.message)}`);
        return false;
    }
}

(async () => {
    const png1 = 'data:image/png;base64,' + makePng(64, 64, 11).toString('base64');
    const png2 = 'data:image/jpeg;base64,' + makePng(64, 64, 77).toString('base64');

    const bindings = await db.all(
        `SELECT b.id, b.channel_id, b.status AS bstatus, c.name AS channel, c.base_url, c.api_key AS channel_api_key,
                c.auth_type AS channel_auth_type, b.req_mapping, b.resp_mapping
         FROM model_bindings b
         JOIN channels c ON c.id = b.channel_id
         JOIN logical_models lm ON lm.id = b.logical_model_id
         WHERE lm.model_name = 'gpt-image-2.5'
         ORDER BY b.id`
    );

    for (const binding of bindings) {
        console.log(`\n${'='.repeat(70)}\n渠道 #${binding.channel_id} ${binding.channel} (${binding.base_url})  绑定 #${binding.id}  status=${binding.bstatus}`);

        await runForBinding(binding, '文生图 curl', {
            model: 'gpt-image-2.5',
            response_format: { type: 'url' },
            size: '1792x1024',
            quality: 'low',
            n: 1,
            messages: [{ role: 'user', content: '生成一张真实摄影风格的城市夜景，电影感，高清细节，自然光影' }]
        });

        await runForBinding(binding, '图生图 curl', {
            model: 'gpt-image-2.5',
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
    }

    await db.pool.end();
})();
