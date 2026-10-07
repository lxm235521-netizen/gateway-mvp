// 只读诊断：查这条任务的快照，并分别探测「上游给的 CDN 直链」与「站内 /download 接口」。
// 只用内置 fetch，避免脚本放在 /tmp 时解析不到 node_modules。
const db = require(process.env.DB_MODULE || '../db');

const GW = 'http://127.0.0.1:3009';
const TASK = process.argv[2] || '92192bb9-800d-4926-9e66-153b301b8bca';

async function probe(label, url, key, timeoutMs = 60000) {
    if (!url) { console.log(`${label}: 无地址`); return; }
    const started = Date.now();
    try {
        const response = await fetch(url, {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(timeoutMs)
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const type = response.headers.get('content-type') || '';
        const extra = type.includes('json') ? ' :: ' + buffer.toString('utf8').slice(0, 160).replace(/\s+/g, ' ') : '';
        console.log(`${label}: HTTP ${response.status} ${type} ${buffer.length} bytes ${Date.now() - started}ms${extra}`);
    } catch (error) {
        console.log(`${label}: ERR ${error.name} ${error.message}`);
    }
}

async function main() {
    const t = await db.get('SELECT * FROM async_tasks WHERE gw_task_id = ?', [TASK]);
    if (!t) { console.log('task not found'); return; }
    console.log('== 任务快照（决定 /content 走哪条分支） ==');
    console.log(`status=${t.status} created_at=${t.created_at?.toISOString?.() || t.created_at} last_poll_at=${t.last_poll_at?.toISOString?.() || t.last_poll_at}`);
    console.log(`poll_throttle_snapshot=${t.poll_throttle_snapshot}   (NULL 才会回落到绑定当前设置)`);
    console.log(`proxy_content_snapshot=${t.proxy_content_snapshot}   (1=代理取流, 0=返回直链 JSON)`);
    console.log(`up_task_id=${t.up_task_id}`);
    const mapping = String(t.poll_mapping_snapshot || '');
    console.log(`poll_mapping_snapshot 版本: ${mapping.includes('$stationUrl') ? '新版（优先站内下载接口）' : '旧版（优先上游 CDN 直链）'}`);
    console.log(`poll_mapping_snapshot 长度=${mapping.length}`);

    const binding = t.binding_id ? await db.get('SELECT id, proxy_content, poll_throttle, status FROM model_bindings WHERE id = ?', [t.binding_id]) : null;
    console.log(`绑定当前设置: proxy_content=${binding && binding.proxy_content} poll_throttle=${binding && binding.poll_throttle} status=${binding && binding.status}`);

    const pollPath = String(t.poll_path_snapshot).replace('${up_task_id}', t.up_task_id);
    const pollUrl = String(t.upstream_base_url).replace(/\/+$/, '') + pollPath;
    let cdnUrl = '';
    try {
        const response = await fetch(pollUrl, { headers: { Authorization: `Bearer ${t.upstream_api_key_snapshot}` }, signal: AbortSignal.timeout(30000) });
        const body = await response.json();
        cdnUrl = body.url || (Array.isArray(body.urls) && body.urls[0]) || '';
        console.log(`\n== 上游 poll ==: HTTP ${response.status} status=${body.status} progress=${body.progress} url_host=${cdnUrl ? new URL(cdnUrl).host : 'none'}`);
    } catch (error) {
        console.log(`\n== 上游 poll 失败 ==: ${error.message}`);
    }

    const stationUrl = `${String(t.upstream_base_url).replace(/\/+$/, '')}/v1/tasks/${t.up_task_id}/download`;
    console.log('\n== 上游地址可用性 ==');
    await probe('CDN 直链（无鉴权）', cdnUrl, null);
    await probe('CDN 直链（带 Bearer）', cdnUrl, t.upstream_api_key_snapshot);
    await probe('站内 /download', stationUrl, t.upstream_api_key_snapshot);

    console.log('\n== 网关 /content（不带 format）连续两次，间隔 3 秒 ==');
    for (let i = 1; i <= 2; i += 1) {
        const started = Date.now();
        try {
            const response = await fetch(`${GW}/v1/videos/${TASK}/content`, { signal: AbortSignal.timeout(120000) });
            const buffer = Buffer.from(await response.arrayBuffer());
            const type = response.headers.get('content-type') || '';
            const text = buffer.length < 400 ? ' :: ' + buffer.toString('utf8').slice(0, 160) : '';
            console.log(`  第${i}次: HTTP ${response.status} ${type} ${buffer.length} bytes ${Date.now() - started}ms${text}`);
        } catch (error) {
            console.log(`  第${i}次: ERR ${error.message}`);
        }
        if (i === 1) await new Promise(r => setTimeout(r, 3000));
    }
}

main().catch(e => { console.error('ERR', e.message); process.exitCode = 1; }).finally(() => db.pool.end());

