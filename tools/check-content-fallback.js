// 只读检查：迁移是否已加 content_fallback_enabled 列，以及各渠道该开关的状态。
// 用法（容器内）：Get-Content tools/check-content-fallback.js -Raw | docker exec -i -e DB_MODULE=/app/db <容器> node -
// 用法（本机）：node tools/run-with-env.js tools/check-content-fallback.js
const db = require(process.env.DB_MODULE || '../db');

async function main() {
    const col = await db.get("SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'channels' AND column_name = 'content_fallback_enabled'");
    console.log('content_fallback_enabled 列:', col ? JSON.stringify(col) : 'MISSING');

    const rows = await db.all('SELECT id, name, content_fallback_enabled, status FROM channels WHERE status = 1 ORDER BY id DESC LIMIT 12');
    for (const r of rows) {
        console.log(`#${r.id} ${r.name} | fallback=${r.content_fallback_enabled} | status=${r.status}`);
    }

    const enabled = await db.all('SELECT COUNT(*) AS n FROM channels WHERE content_fallback_enabled = 1');
    console.log('开启兜底的渠道数:', enabled[0].n);
}

main().catch(e => { console.error('ERR', e.message); process.exitCode = 1; }).finally(() => db.pool.end());
