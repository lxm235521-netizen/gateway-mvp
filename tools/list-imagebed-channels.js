// 只读：列出开启了 base64->url 转换的渠道，以及它们对应的逻辑模型（用于真实链路验证）。
const db = require(process.env.DB_MODULE || '../db');

async function main() {
    const channels = await db.all(`SELECT id, name, base_url, convert_base64_to_url, convert_resp_base64_to_url, status
        FROM channels WHERE convert_base64_to_url = 1 OR convert_resp_base64_to_url = 1 ORDER BY id`);
    console.log('== 开启图床转换的渠道 ==');
    for (const c of channels) {
        console.log(`#${c.id} ${c.name} | req=${c.convert_base64_to_url} resp=${c.convert_resp_base64_to_url} | status=${c.status} | ${c.base_url}`);
    }
    console.log('\n== 这些渠道上的绑定 ==');
    const bindings = await db.all(`SELECT b.id, lm.model_name, c.name AS channel, c.convert_base64_to_url, c.convert_resp_base64_to_url,
            b.route_path, b.is_async, b.status, b.weight
        FROM model_bindings b JOIN channels c ON c.id = b.channel_id JOIN logical_models lm ON lm.id = b.logical_model_id
        WHERE c.convert_base64_to_url = 1 OR c.convert_resp_base64_to_url = 1 ORDER BY b.id`);
    for (const b of bindings) {
        console.log(`#${b.id} ${b.model_name} | ${b.channel} | req=${b.convert_base64_to_url} resp=${b.convert_resp_base64_to_url} | ${b.route_path} | async=${b.is_async} status=${b.status}`);
    }
}
main().catch(e => { console.error('ERR', e.message); process.exitCode = 1; }).finally(() => db.pool.end());
