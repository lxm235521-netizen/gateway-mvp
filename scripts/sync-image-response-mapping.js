// 把统一图片响应映射（scripts/image-response-mapping.js）同步到图片逻辑模型的绑定上。
//
// 下游契约（CHANNEL_MAPPING_GUIDE.md 第 4 节）：
//   { "model": "<逻辑模型名>", "url": "<http 链接 或 裸 base64>" }
//
// 背景：旧 resp_mapping 只取 data[0].url。上游在 response_format=b64_json 时返回
//   { "created": ..., "data": [{ "revised_prompt": ..., "b64_json": "...", ... }] }
// —— 根本没有 url 字段，于是映射出来的响应只剩 { "model": ..., "created": ... }，
// 下游拿不到任何图片。统一映射在「有链接时给链接、只有 base64 时把 base64 放进 url」，
// 所以下游始终能从同一个 url 字段拿到图片。
//
// 安全边界：
//   - 默认 --dry-run，只打印将要修改的绑定；--apply 才写库。
//   - 默认**只处理已启用的绑定**（model_bindings.status=1 且 channels.status=1），
//     停用的绑定保持原样；确需一起改时加 --include-disabled。
//   - 只处理逻辑模型名精确等于 --models（默认 gpt-image-2,gpt-image-2.5）的绑定，
//     不会碰到 gpt-image-2-1k / -4k / -企业 等其它模型。
//   - 跳过异步绑定（is_async=1 或真正的 poll_mapping），避免把视频响应改成图片结构。
//   - 只更新 resp_mapping 一列：不动 status / weight / req_mapping 等任何其它字段。
//   - 已经是最新映射的绑定直接跳过，因此可以重复执行。
//
// 用法（必须显式指定目标库，避免连错环境）：
//   $env:DB_HOST='154.36.173.77'; $env:DB_PORT='3310'; $env:DB_NAME='gateway'
//   $env:DB_USER='gateway'; $env:DB_PASSWORD='gateway-password'
//   $env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//   node scripts/sync-image-response-mapping.js --dry-run
//   node scripts/sync-image-response-mapping.js --apply
//   可选：--models gpt-image-2              # 只同步一个模型
//         --include-disabled               # 连停用的绑定一起改
//   容器内：docker exec <容器名> node scripts/sync-image-response-mapping.js --apply
const assert = require('node:assert/strict');
const { buildImageResponseMapping } = require('./image-response-mapping');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');
const includeDisabled = process.argv.includes('--include-disabled');
const modelsArg = process.argv[process.argv.indexOf('--models') + 1];
const modelNames = process.argv.includes('--models') && modelsArg
    ? modelsArg.split(',').map(name => name.trim()).filter(Boolean)
    : ['gpt-image-2', 'gpt-image-2.5'];

assert.ok(modelNames.length > 0, 'No logical model name to sync');

async function main() {
    const expectedHost = process.env.EXPECTED_DB_HOST;
    const expectedDb = process.env.EXPECTED_DB_NAME;
    assert.ok(expectedHost && expectedDb, 'Set EXPECTED_DB_HOST and EXPECTED_DB_NAME explicitly');
    assert.equal(process.env.DB_HOST, expectedHost, 'Unexpected DB_HOST');
    assert.equal(process.env.DB_NAME, expectedDb, 'Unexpected DB_NAME');
    assert.equal((await db.get('SELECT DATABASE() AS name')).name, expectedDb, 'Unexpected connected database');

    const placeholders = modelNames.map(() => '?').join(',');
    const bindings = await db.all(
        `SELECT b.id, b.logical_model_id, b.resp_mapping, b.poll_mapping, b.is_async, b.status,
                lm.model_name, c.name AS channel_name, c.base_url, c.status AS channel_status,
                c.convert_resp_base64_to_url
         FROM model_bindings b
         JOIN logical_models lm ON lm.id = b.logical_model_id
         JOIN channels c ON c.id = b.channel_id
         WHERE lm.model_name IN (${placeholders})
         ORDER BY lm.model_name, b.id`,
        modelNames
    );
    assert.ok(bindings.length > 0, `No binding found for ${modelNames.join(', ')}`);

    const targets = [];
    for (const binding of bindings) {
        const expectedResp = buildImageResponseMapping(binding.model_name);
        const currentResp = String(binding.resp_mapping || '');
        const enabled = Number(binding.status) === 1 && Number(binding.channel_status) === 1;
        const label = `binding #${binding.id} ${binding.model_name} @ ${binding.channel_name} (${binding.base_url}) `
            + `status=${binding.status} channel_status=${binding.channel_status}`;
        if (!enabled && !includeDisabled) {
            console.log(`${label}: 未启用，跳过（需要时加 --include-disabled）`);
            continue;
        }
        if (hasAsyncTaskFlow(binding)) {
            console.log(`${label}: 异步任务绑定（is_async / poll_mapping），跳过`);
            continue;
        }
        if (currentResp === expectedResp) {
            console.log(`${label}: 已是统一响应映射，跳过`);
            continue;
        }
        // b64 -> 链接的渠道会在 server.js 里再做一次转换，这里仍统一成同一份映射，
        // 保证所有绑定对下游的响应结构一致（转换后下游拿到的是图床链接）。
        console.log(`${label}: 将更新 resp_mapping${Number(binding.convert_resp_base64_to_url) ? '（渠道 convert_resp_base64_to_url=1，base64 随后会换成链接）' : ''}`);
        console.log(`  旧: ${summarize(currentResp)}`);
        targets.push({ ...binding, expectedResp });
    }

    if (!targets.length) {
        console.log('没有需要更新的绑定');
        return;
    }

    const conn = await db.pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const binding of targets) {
            if (!dryRun) {
                await conn.execute('UPDATE model_bindings SET resp_mapping = ? WHERE id = ?', [binding.expectedResp, binding.id]);
            }
        }
        if (dryRun) {
            await conn.rollback();
            console.log(JSON.stringify({ dry_run: true, database: expectedDb, updated: targets.map(binding => binding.id) }));
        } else {
            await conn.commit();
            console.log(JSON.stringify({ applied: true, database: expectedDb, updated: targets.map(binding => binding.id) }));
        }
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

// 图片接口是同步返回的；异步绑定（视频/任务轮询）的响应结构是另一套契约，不能套用。
// 库里图片绑定的 poll_mapping 常被填成无操作的 '{}'，所以不能只看「非空」。
function hasAsyncTaskFlow(binding) {
    if (Number(binding.is_async) === 1) {
        return true;
    }
    const poll = String(binding.poll_mapping || '').replace(/\s+/g, '');
    return poll !== '' && poll !== '{}' && poll !== '()' && poll !== 'null';
}

// 单行摘要，避免把整段 JSONata 打到日志里。
function summarize(mapping) {
    const compact = String(mapping).replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
