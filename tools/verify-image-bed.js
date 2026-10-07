// 端到端验证：下游传 data URL 图片 -> 网关上传到新图床 -> 替换成 https 链接 -> 转发上游。
// 探针用「请求体查看」渠道（webhook.site），它会把网关实际发出的请求体回显出来。
const axios = require('axios');

const GATEWAY = process.env.GATEWAY || 'http://127.0.0.1:3009';
const GW_KEY = process.env.GW_KEY || 'sk-test-key-123';
const WEBHOOK_API = process.env.WEBHOOK_API || 'https://webhook.site/token/68eaa184-39ab-4022-803e-7101ac7d4e0c/requests';

// 1x1 PNG（真实可解码的图片）
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9UeIAAAAAElFTkSuQmCC';

async function latestWebhookBodies(limit = 5) {
    const response = await axios.get(`${WEBHOOK_API}?sorting=newest&per_page=${limit}`, { timeout: 30000 });
    return (response.data && response.data.data) || [];
}

async function main() {
    const before = await latestWebhookBodies(1).catch(() => []);
    const beforeId = before[0] && before[0].uuid;

    const submit = await axios.post(`${GATEWAY}/v1/videos`, {
        model: '75api-minimax-h3-audio-20260911_tscyh_copy',
        prompt: 'image bed verification probe',
        seconds: '5',
        images: [PNG_DATA_URL]
    }, {
        headers: { Authorization: `Bearer ${GW_KEY}`, 'Content-Type': 'application/json' },
        timeout: 120000,
        validateStatus: () => true
    });
    console.log(`网关提交: HTTP ${submit.status}`);
    console.log('  ' + JSON.stringify(submit.data).slice(0, 300));

    // 等 webhook 收到请求（上游是同步返回的 webhook，一般很快）
    let body = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise(r => setTimeout(r, 2500));
        const items = await latestWebhookBodies(3).catch(() => []);
        const fresh = items.find(item => item.uuid !== beforeId);
        if (fresh) { body = fresh; break; }
    }

    if (!body) {
        console.log('未在 webhook.site 上看到新请求（上游可能拒绝或网络不通）');
        process.exitCode = 1;
        return;
    }

    const content = body.content || '';
    console.log('\n上游收到的请求体:');
    console.log(content.slice(0, 1200));

    const newBed = /https:\/\/files\.mmg\.lat\/u\/[A-Za-z0-9]+\.png/.test(content);
    const oldBed = /wgspai/.test(content);
    const stillDataUrl = /data:image\//.test(content);

    console.log('');
    console.log(`${newBed ? 'PASS' : 'FAIL'}  请求体里出现新图床链接 (files.mmg.lat/u/...)`);
    console.log(`${!oldBed ? 'PASS' : 'FAIL'}  不再出现旧图床域名`);
    console.log(`${!stillDataUrl ? 'PASS' : 'FAIL'}  data URL 已被替换（不再原样透传 base64）`);

    const match = content.match(/https:\/\/files\.mmg\.lat\/u\/[A-Za-z0-9]+\.png/);
    if (match) {
        const probe = await axios.get(match[0], { responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true });
        console.log(`${probe.status === 200 ? 'PASS' : 'FAIL'}  图床链接可下载: HTTP ${probe.status}, ${probe.data ? probe.data.length : 0} bytes, ${probe.headers['content-type']}`);
    }

    process.exitCode = (newBed && !oldBed && !stillDataUrl) ? 0 : 1;
}

main().catch(error => { console.error('ERR', error.message); process.exitCode = 1; });
