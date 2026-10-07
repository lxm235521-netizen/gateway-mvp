// 只读检查：列出渠道与图片类逻辑模型的绑定，便于配置前确认现状。
const db = require('../db');

async function main() {
    const channels = await db.all('SELECT id, name, base_url, auth_type, status, convert_base64_to_url, api_key IS NOT NULL AND api_key <> \'\' AS has_key FROM channels ORDER BY id');
    console.log('== channels ==');
    for (const c of channels) {
        console.log(`#${c.id} ${c.name} | ${c.base_url} | ${c.auth_type} | status=${c.status} | b64->url=${c.convert_base64_to_url} | key=${c.has_key}`);
    }

    const models = await db.all("SELECT id, model_name, status FROM logical_models WHERE model_name LIKE '%image%' ORDER BY id");
    console.log('\n== image logical_models ==');
    for (const m of models) {
        console.log(`#${m.id} ${m.model_name} status=${m.status}`);
    }

    const bindings = await db.all(`SELECT b.id, b.logical_model_id, lm.model_name, b.channel_id, c.name AS channel_name,
            c.base_url, b.status, b.weight, b.route_path, b.is_async, b.proxy_content, b.error_passthrough,
            LENGTH(b.req_mapping) AS req_len, LENGTH(b.resp_mapping) AS resp_len
        FROM model_bindings b
        JOIN channels c ON c.id = b.channel_id
        JOIN logical_models lm ON lm.id = b.logical_model_id
        WHERE lm.model_name LIKE '%image%'
        ORDER BY b.id`);
    console.log('\n== image bindings ==');
    for (const b of bindings) {
        console.log(`#${b.id} model=${b.model_name}(${b.logical_model_id}) channel=${b.channel_name}(${b.channel_id}) ${b.base_url} status=${b.status} weight=${b.weight} route=${b.route_path} async=${b.is_async} proxy=${b.proxy_content} req_len=${b.req_len} resp_len=${b.resp_len}`);
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
