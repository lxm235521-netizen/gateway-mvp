// 端到端验证 /content?format=h264：首次转码、缓存复用、Range、并发去重、非 h264 路径不变。
// 用法：node tools/verify-content-h264.js <网关地址> <gw_task_id> [网关密钥]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BASE = (process.argv[2] || 'http://127.0.0.1:3009').replace(/\/+$/, '');
const TASK = process.argv[3];
const KEY = process.argv[4] || '';
const OUT_DIR = path.resolve(__dirname, '_tmp-out');
const AUTH = KEY ? { Authorization: `Bearer ${KEY}` } : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const failures = [];
function check(label, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ' :: ' + detail}`);
    if (!ok) failures.push(label);
}

async function fetchContent(query) {
    const started = Date.now();
    const res = await fetch(`${BASE}/v1/videos/${TASK}/content${query}`, { headers: AUTH, signal: AbortSignal.timeout(600000) });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { res, buffer, ms: Date.now() - started };
}

// 用容器里的 ffprobe 读编码（本机没有 ffprobe）。
function probe(file) {
    const out = execFileSync('docker', [
        'run', '--rm', '-v', `${OUT_DIR}:/w:ro`, '--entrypoint', 'ffprobe', 'linuxserver/ffmpeg:latest',
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height',
        '-show_entries', 'format=duration,size',
        '-of', 'default=noprint_wrappers=1', `/w/${path.basename(file)}`
    ], { encoding: 'utf8' });
    const info = {};
    for (const line of out.split(/\r?\n/)) {
        const [k, v] = line.split('=');
        if (k) info[k.trim()] = v === undefined ? '' : v.trim();
    }
    return info;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // 1) 原始路径不受影响：不带 format 仍是上游编码（HEVC）
    await sleep(7000);
    const original = await fetchContent('');
    const originalFile = path.join(OUT_DIR, 'h264-original.mp4');
    fs.writeFileSync(originalFile, original.buffer);
    console.log(`原始 /content: HTTP ${original.res.status} ${original.res.headers.get('content-type')} ${original.buffer.length} bytes ${original.ms}ms`);
    const originalInfo = original.res.headers.get('content-type').startsWith('video/') ? probe(originalFile) : {};
    check('不带 format 时仍返回视频流', original.res.headers.get('content-type').startsWith('video/'), original.res.headers.get('content-type'));
    check('原路径仍是上游 HEVC 编码（行为未变）', originalInfo.codec_name === 'hevc', originalInfo.codec_name);

    // 2) 首次请求 format=h264 触发转码
    await sleep(7000);
    const first = await fetchContent('?format=h264');
    const h264File = path.join(OUT_DIR, 'h264-rendition.mp4');
    fs.writeFileSync(h264File, first.buffer);
    console.log(`首次 ?format=h264: HTTP ${first.res.status} ${first.res.headers.get('content-type')} ${first.buffer.length} bytes ${first.ms}ms`);
    check('format=h264 返回 200', first.res.status === 200, `HTTP ${first.res.status}`);
    check('format=h264 返回 video/mp4', first.res.headers.get('content-type') === 'video/mp4', first.res.headers.get('content-type'));
    const h264Info = probe(h264File);
    console.log('  产物:', JSON.stringify(h264Info));
    check('产物编码是 h264', h264Info.codec_name === 'h264', h264Info.codec_name);
    check('分辨率未变（1280x720）', h264Info.width === '1280' && h264Info.height === '720', `${h264Info.width}x${h264Info.height}`);
    check('时长未明显变化（约 15s）', Math.abs(Number(h264Info.duration) - Number(originalInfo.duration)) < 1, `${originalInfo.duration} -> ${h264Info.duration}`);

    // 3) 第二次请求应命中缓存（明显更快）
    await sleep(7000);
    const second = await fetchContent('?format=h264');
    console.log(`再次 ?format=h264: HTTP ${second.res.status} ${second.buffer.length} bytes ${second.ms}ms`);
    check('缓存复用：字节数与首次一致', second.buffer.length === first.buffer.length, `${first.buffer.length} -> ${second.buffer.length}`);
    check('缓存复用：明显更快', second.ms < first.ms, `${first.ms}ms -> ${second.ms}ms`);

    // 4) Range 支持（播放器拖进度条）
    await sleep(7000);
    const full = second.buffer.length;
    const rangeRes = await fetch(`${BASE}/v1/videos/${TASK}/content?format=h264`, { headers: { ...AUTH, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(120000) });
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    console.log(`Range: HTTP ${rangeRes.status} content-range=${rangeRes.headers.get('content-range')} ${rangeBuf.length} bytes`);
    check('Range 返回 206', rangeRes.status === 206, `HTTP ${rangeRes.status}`);
    check('Range 切片长度正确', rangeBuf.length === 1024, `${rangeBuf.length}`);
    check('content-range 总数正确', (rangeRes.headers.get('content-range') || '').endsWith(`/${full}`), rangeRes.headers.get('content-range'));

    // 5) 并发只转一次（缓存已存在时并发也应一致）
    await sleep(7000);
    const concurrent = await Promise.all([0, 1, 2].map(() => fetchContent('?format=h264')));
    const sizes = concurrent.map(c => c.buffer.length);
    console.log(`并发 3 次: ${sizes.join(', ')}`);
    check('并发请求字节数一致', sizes.every(s => s === full), sizes.join(','));

    console.log(failures.length ? `\n${failures.length} 项失败: ${failures.join('; ')}` : '\n全部通过');
    process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => { console.error('ERR', error.message); process.exitCode = 1; });
