// 验证网关图床（Zipline: https://files.mmg.lat/api/upload）当前是否可用。
// 上传一张 1x1 的透明 PNG，打印返回的链接；不做任何写入以外的操作。
// 用法:
//   node tools/check-image-bed.js
//   ZIPLINE_KEY=zk_xxx IMAGE_BED_UPLOAD_URL=https://files.mmg.lat/api/upload node tools/check-image-bed.js
const axios = require('axios');
const FormData = require('form-data');

const UPLOAD_URL = process.env.IMAGE_BED_UPLOAD_URL || 'https://files.mmg.lat/api/upload';
const TOKEN = process.env.IMAGE_BED_TOKEN || process.env.ZIPLINE_KEY || 'zk_8a158b96b31bb2e30eeee88f41a2e6c7';
const AUTH_HEADER = process.env.IMAGE_BED_AUTH_HEADER || 'Authorization';
const NO_JSON = process.env.IMAGE_BED_NO_JSON !== '0';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');

// 与 server.js 中的 extractImageBedUrl 保持一致：纯文本 URL 与 JSON 两种回答都接受。
function extractImageBedUrl(response) {
    const data = response && response.data;
    if (typeof data === 'string') {
        const text = data.trim();
        if (/^https?:\/\/\S+$/i.test(text)) return text;
        try { return extractImageBedUrl({ data: JSON.parse(text) }); } catch { return null; }
    }
    if (data && typeof data === 'object') {
        if (typeof data.url === 'string' && data.url.trim()) return data.url.trim();
        if (Array.isArray(data.files) && data.files[0] && typeof data.files[0].url === 'string') return data.files[0].url.trim();
    }
    return null;
}

async function upload(label, headers, parseJson) {
    const form = new FormData();
    form.append('file', png, { filename: 'probe.png', contentType: 'image/png' });
    const started = Date.now();
    try {
        const res = await axios.post(UPLOAD_URL, form, {
            headers: { ...form.getHeaders(), ...headers },
            timeout: 60000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true
        });
        const url = extractImageBedUrl(res);
        console.log(`${label}: HTTP ${res.status} ${Date.now() - started}ms`);
        console.log(`  raw      : ${typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data).slice(0, 200)}`);
        console.log(`  parsed   : ${url || '(解析失败)'}`);
        return { status: res.status, url };
    } catch (error) {
        console.log(`${label}: FAIL ${error.message}`);
        return { status: 0, url: null };
    }
}

async function main() {
    console.log(`图床地址: ${UPLOAD_URL}`);
    console.log(`鉴权头  : ${AUTH_HEADER}${TOKEN ? ' (已配置)' : ' (未配置)'}`);
    console.log('');

    const headers = {};
    if (TOKEN) headers[AUTH_HEADER] = TOKEN;
    if (NO_JSON) headers['x-zipline-no-json'] = 'true';
    const plain = await upload('纯文本回答（网关默认用法）', headers, false);

    const jsonHeaders = {};
    if (TOKEN) jsonHeaders[AUTH_HEADER] = TOKEN;
    const asJson = await upload('JSON 回答（兜底解析路径）', jsonHeaders, true);

    const ok = plain.url && asJson.url;
    console.log('');
    console.log(ok ? '结论: 图床可用（两种回答都能解析出链接）' : '结论: 图床异常，请检查地址与 key');
    process.exitCode = ok ? 0 : 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
