// 只读检查：确认 688 渠道与 gpt-image-2 绑定的最终状态，以及没有残留的临时记录。
const db = require('../db');

async function main() {
    const channels = await db.all(
        "SELECT id, name, base_url, status, auth_type, convert_base64_to_url AS req_flag, convert_resp_base64_to_url AS resp_flag FROM channels WHERE name LIKE '%688%' OR name LIKE 'ZZ %' OR id IN (3, 22) ORDER BY id"
    );
    console.log('== channels ==');
    for (const row of channels) {
        console.log(`#${row.id} ${row.name} | ${row.base_url} | status=${row.status} | req_b64=${row.req_flag} | resp_b64=${row.resp_flag}`);
    }

    const bindings = await db.all(
        `SELECT b.id, b.channel_id, c.name AS channel_name, b.status, b.weight, b.route_path,
                LENGTH(b.req_mapping) AS req_len, LENGTH(b.resp_mapping) AS resp_len,
                b.req_mapping = (SELECT req_mapping FROM model_bindings WHERE id = 199) AS same_req_as_688
         FROM model_bindings b
         JOIN channels c ON c.id = b.channel_id
         JOIN logical_models lm ON lm.id = b.logical_model_id
         WHERE lm.model_name = 'gpt-image-2'
         ORDER BY b.id`
    );
    console.log('\n== gpt-image-2 bindings ==');
    for (const row of bindings) {
        console.log(`#${row.id} ${row.channel_name} status=${row.status} weight=${row.weight} route=${row.route_path} req_len=${row.req_len} resp_len=${row.resp_len} sameReqAs688=${row.same_req_as_688}`);
    }

    const leftovers = await db.all("SELECT id, name FROM channels WHERE name LIKE 'ZZ %'");
    console.log('\nleftover temp channels:', leftovers.length ? JSON.stringify(leftovers) : 'none');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
