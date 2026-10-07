// 只读检查：打印指定绑定 id 的映射全文与渠道信息，用于比对「同源」映射。
const db = require('../db');

async function main() {
    const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
    const rows = await db.all(
        `SELECT b.id, lm.model_name, c.name AS channel_name, c.base_url, c.auth_type, b.status, b.route_path,
                b.req_mapping, b.resp_mapping, b.poll_mapping
         FROM model_bindings b
         JOIN channels c ON c.id = b.channel_id
         JOIN logical_models lm ON lm.id = b.logical_model_id
         WHERE b.id IN (${ids.map(() => '?').join(',')})`,
        ids
    );
    for (const row of rows) {
        console.log(`\n########## binding #${row.id} ${row.model_name} -> ${row.channel_name} ${row.base_url} status=${row.status} route=${row.route_path}`);
        console.log('--- req_mapping ---');
        console.log(row.req_mapping);
        console.log('--- resp_mapping ---');
        console.log(row.resp_mapping);
        console.log('--- poll_mapping ---');
        console.log(row.poll_mapping);
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
