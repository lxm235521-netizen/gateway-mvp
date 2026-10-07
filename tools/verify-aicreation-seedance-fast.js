// 端到端校验：通过运行中的网关创建一条 AI 创作 Seedance 2.0 Fast 视频任务，
// 轮询到终态，并验证 /v1/videos/{id}/content 的网关代理取流（含 Range）。
//
// 用法：node tools/verify-aicreation-seedance-fast.js <网关地址> <网关密钥> [--submit-only]
//   例：node tools/verify-aicreation-seedance-fast.js http://127.0.0.1:3009 sk-test-key-123
//
// 注意：这会创建一条真实的上游视频生成任务（上游按次计费），只在需要端到端确认时运行。
const BASE = (process.argv[2] || 'http://127.0.0.1:3009').replace(/\/+$/, '');
const GATEWAY_KEY = process.argv[3] || '';
const submitOnly = process.argv.includes('--submit-only');
const MODEL = process.env.MODEL_NAME || 'Seedance 2.0 Fast';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function report(label, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ' :: ' + detail}`);
    return ok;
}

async function main() {
    const failures = [];
    const check = (label, ok, detail) => { if (!report(label, ok, detail)) failures.push(label); };

    const submitRes = await fetch(`${BASE}/v1/videos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GATEWAY_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            prompt: 'A static test pattern with minimal motion',
            seconds: '5',
            aspect_ratio: '16:9',
            resolution: '1080p'
        }),
        signal: AbortSignal.timeout(120000)
    });
    const submitted = await submitRes.json();
    console.log(`submit -> HTTP ${submitRes.status} ${JSON.stringify(submitted)}`);
    check('gateway accepts the request', submitRes.status === 200, `HTTP ${submitRes.status}`);
    check('gateway returns its own task id', typeof submitted.id === 'string' && submitted.id.length > 0);
    check('gateway returns status queued', submitted.status === 'queued', submitted.status);
    check('gateway echoes the logical model', submitted.model === MODEL, submitted.model);
    if (!submitted.id || submitOnly) {
        return failures;
    }

    const gwTaskId = submitted.id;
    let last = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(attempt === 0 ? 8000 : 10000);
        const pollRes = await fetch(`${BASE}/v1/videos/${encodeURIComponent(gwTaskId)}`, {
            headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
            signal: AbortSignal.timeout(60000)
        });
        last = await pollRes.json();
        console.log(`poll#${attempt} -> HTTP ${pollRes.status} ${JSON.stringify(last)}`);
        if (last.status === 'completed' || last.status === 'failed') {
            break;
        }
    }
    check('task reached a terminal state', last && (last.status === 'completed' || last.status === 'failed'), last && last.status);
    check('terminal state is completed', last && last.status === 'completed', last && last.status);
    check('poll result keeps the gateway task id', last && last.id === gwTaskId && last.task_id === gwTaskId);
    check('completed result exposes a video url', last && typeof last.video_url === 'string' && last.video_url.length > 0, last && last.video_url);
    check('completed progress is 100', last && last.progress === 100, last && last.progress);
    if (!last || last.status !== 'completed') {
        return failures;
    }

    // /content 匿名可访问，并且开启代理后直接返回视频流（不是 {"url": ...}）。
    const contentRes = await fetch(`${BASE}/v1/videos/${encodeURIComponent(gwTaskId)}/content`, { signal: AbortSignal.timeout(60000) });
    const contentType = contentRes.headers.get('content-type') || '';
    const contentLength = contentRes.headers.get('content-length');
    const acceptRanges = contentRes.headers.get('accept-ranges');
    const buffer = Buffer.from(await contentRes.arrayBuffer());
    console.log(`content -> HTTP ${contentRes.status} content-type=${contentType} content-length=${contentLength} accept-ranges=${acceptRanges} bytes=${buffer.length}`);
    check('content returns HTTP 200', contentRes.status === 200, `HTTP ${contentRes.status}`);
    check('content is a video stream', contentType.startsWith('video/'), contentType);
    check('content is not empty', buffer.length > 1024, `${buffer.length} bytes`);

    const rangeRes = await fetch(`${BASE}/v1/videos/${encodeURIComponent(gwTaskId)}/content`, {
        headers: { Range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(60000)
    });
    const rangeBuffer = Buffer.from(await rangeRes.arrayBuffer());
    console.log(`content range -> HTTP ${rangeRes.status} content-range=${rangeRes.headers.get('content-range')} bytes=${rangeBuffer.length}`);
    check('range request is forwarded', rangeRes.status === 206, `HTTP ${rangeRes.status}`);
    check('range returns the requested slice', rangeBuffer.length === 1024, `${rangeBuffer.length} bytes`);

    return failures;
}

main()
    .then(failures => {
        console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nall checks passed');
        process.exitCode = failures.length ? 1 : 0;
    })
    .catch(error => { console.error('ERR', error.message); process.exitCode = 1; });
