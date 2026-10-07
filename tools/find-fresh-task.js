// 找一条刚完成、上游成品仍可下载的任务，用作 H.264 转码端到端验证的素材。
// 只读：先列出最近完成的任务，再逐个探测上游成品地址是否还能取到字节（不写入任何东西）。
// 用法（容器内）：Get-Content tools/find-fresh-task.js -Raw | docker exec -i -e DB_MODULE=/app/db <容器> node -
const db = require(process.env.DB_MODULE || '../db');
const axios = require('axios');

const BASE_OVERRIDE = process.env.PROBE_BASE_URL || '';

async function tryDownload(task) {
    const base = BASE_OVERRIDE || task.upstream_base_url;
    if (!base || !task.up_task_id) return null;
    const url = `${String(base).replace(/\/+$/, '')}/v1/tasks/${encodeURIComponent(task.up_task_id)}/download`;
    try {
        const response = await axios.get(url, {
            headers: task.upstream_api_key_snapshot ? { Authorization: `Bearer ${task.upstream_api_key_snapshot}` } : {},
            responseType: 'arraybuffer',
            timeout: 20000,
            maxContentLength: 50 * 1024 * 1024,
            validateStatus: () => true
        });
        return { url, status: response.status, bytes: response.data ? response.data.length : 0 };
    } catch (error) {
        return { url, status: 'ERR', bytes: 0, message: error.message };
    }
}

async function main() {
    const tasks = await db.all(`SELECT gw_task_id, up_task_id, status, created_at, upstream_base_url,
            upstream_api_key_snapshot, binding_id, logical_model_id
        FROM async_tasks
        WHERE status = 'completed' AND binding_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 12`);
    console.log(`最近完成的任务 ${tasks.length} 条，逐个探测成品是否可下载（只对 AI 创作渠道有意义）:\n`);
    for (const t of tasks) {
        const result = await tryDownload(t);
        const marker = result && result.status === 200 ? '  <== 可用素材' : '';
        console.log(`${t.gw_task_id} | ${t.created_at.toISOString ? t.created_at.toISOString() : t.created_at} | binding=${t.binding_id} | ${result ? result.status + ' ' + result.bytes + 'B' : 'skip'}${marker}`);
    }
}

main().catch(e => { console.error('ERR', e.message); process.exitCode = 1; }).finally(() => db.pool.end());
