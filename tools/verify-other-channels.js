// 回归验证：其他渠道已完成的真实任务，在【不带 format 参数】时的 /content 行为必须与改动前一致。
// 覆盖代理类（proxy_content=1）与直链类（proxy_content=0）两个分支。
// 用法：node tools/verify-other-channels.js <网关地址> [网关密钥]
const BASE = (process.argv[2] || 'http://127.0.0.1:3009').replace(/\/+$/, '');
const KEY = process.argv[3] || '';
const AUTH = KEY ? { Authorization: `Bearer ${KEY}` } : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每个渠道挑一条最近完成的真实任务（gw_task_id / 期望分支 / 说明）。
const TARGETS = [
    ['58a4535f-6c5f-498e-9c69-9ba3a8cb251e', 'proxy', 'Grok Video（proxy_content=1）'],
    ['ac9648bb-4d16-4eff-88b0-c122647d7715', 'direct', 'Vylai MiniMax H3（proxy_content=0，直链）'],
    ['85f34455-45d8-4b07-a5a8-457c32243642', 'direct', 'Vylai 75api-minimax-h3-ref（直链）'],
    ['e06505cd-c65c-4401-9122-ac15bab9161b', 'direct', 'Vylai _tscyh（直链）']
];

const failures = [];

async function checkTask(taskId, branch, label) {
    console.log(`\n== ${label} ==`);
    // 1) 轮询状态：确认任务仍是完成态，且响应形状未变
    const pollRes = await fetch(`${BASE}/v1/videos/${taskId}`, { headers: AUTH, signal: AbortSignal.timeout(60000) });
    const poll = await pollRes.json();
    console.log(`   poll HTTP ${pollRes.status} status=${poll.status} progress=${poll.progress} video_url=${(poll.video_url || '').slice(0, 90)}`);
    if (poll.status !== 'completed') {
        console.log('   (任务不是完成态，跳过取流检查)');
        failures.push(`${label}: poll status ${poll.status}`);
        return;
    }

    await sleep(7000); // 避开 poll_throttle
    const res = await fetch(`${BASE}/v1/videos/${taskId}/content`, { headers: AUTH, signal: AbortSignal.timeout(120000) });
    const type = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`   content HTTP ${res.status} content-type=${type} bytes=${buffer.length}`);

    if (branch === 'proxy') {
        // 代理类：应直接返回视频流（200 + video/*），或上游不可用时 502 upstream_status
        const ok = (res.status === 200 && type.startsWith('video/')) || (res.status === 502 && buffer.length < 400);
        console.log(`   ${ok ? 'PASS' : 'FAIL'}  代理分支行为符合预期（视频流或上游错误 JSON，不是崩溃/空响应）`);
        if (!ok) failures.push(`${label}: proxy branch HTTP ${res.status} ${type}`);
    } else {
        // 直链类：应返回 {"url": "<上游地址>"}
        let body = null;
        try { body = JSON.parse(buffer.toString('utf8')); } catch { /* 不是 JSON */ }
        const ok = res.status === 200 && body && typeof body.url === 'string' && (body.url.startsWith('http') || body.url === '');
        console.log(`   ${ok ? 'PASS' : 'FAIL'}  直链分支返回 {"url": ...} 形状`);
        if (!ok) failures.push(`${label}: direct branch HTTP ${res.status} body=${buffer.toString('utf8').slice(0, 120)}`);
    }
}

(async () => {
    for (const [taskId, branch, label] of TARGETS) {
        await checkTask(taskId, branch, label);
    }
    console.log(failures.length ? `\n${failures.length} 项不符: ${failures.join(' | ')}` : '\n其他渠道回归全部符合预期');
    process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error('ERR', error.message); process.exitCode = 1; });
