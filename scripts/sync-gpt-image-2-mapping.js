// 把 scripts/klong-gpt-image-2-config.js 里的 req_mapping / resp_mapping
// 同步到「与 Klong 同源」的 gpt-image-2 绑定上。
//
// 背景：渠道「gpt图片生成」(channel 3, binding #2)、「gpt图片生成 Klong」
// (channel 22, binding #192) 与「gpt图片生成 688」(img.688.qzz.io) 本来共用同一份映射，
// 只为这些渠道同时支持「统一模板」和「OpenAI messages 风格」两种下游请求，需要一起更新。
// 688 渠道的 resp_mapping 在此基础上扩展了 base64 归一，因此不同步 resp_mapping 到它，
// 只同步 req_mapping（它必须与 Klong 逐字相同）。
//
// 安全边界：
//   - 默认只更新「当前映射与旧版映射逐字相同」的绑定，避免误伤其它渠道
//     （例如 YuanAI 的 gpt-image-2 绑定是 4K 专用映射，不在此列）。
//   - 不修改 status / weight，不会把停用的绑定重新启用。
//   - --all-bindings 才会把全部 gpt-image-2 绑定改为新映射（默认关闭）。
//
// 用法（必须显式指定目标库）：
//   $env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//   node scripts/sync-gpt-image-2-mapping.js --dry-run
//   node scripts/sync-gpt-image-2-mapping.js --apply
const assert = require('node:assert/strict');
const { req_mapping, resp_mapping, legacy_req_mappings } = require('./klong-gpt-image-2-config');
const img688 = require('./img688-gpt-image-2-config');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');
const allBindings = process.argv.includes('--all-bindings');

// 688 渠道的 req_mapping 与 Klong 必须逐字一致，否则下游在两个渠道之间路由会得到不同请求体。
assert.equal(img688.req_mapping, req_mapping, '688 渠道的 req_mapping 必须与 Klong 保持一致');

// 「同源」判定：绑定的 req_mapping 等于本文件历次发布过的任一版本，
// 或等于 688 渠道自己登记的历史版本。
// 这样既能更新本渠道自己的旧绑定，又不会误伤其它渠道（例如 YuanAI 的 4K 专用映射）。
const SIBLING_REQ_MAPPINGS = new Set([req_mapping, ...legacy_req_mappings, ...img688.legacy_req_mappings]);

async function main() {
    const expectedHost = process.env.EXPECTED_DB_HOST;
    const expectedDb = process.env.EXPECTED_DB_NAME;
    assert.ok(expectedHost && expectedDb, 'Set EXPECTED_DB_HOST and EXPECTED_DB_NAME explicitly');
    assert.equal(process.env.DB_HOST, expectedHost, 'Unexpected DB_HOST');
    assert.equal(process.env.DB_NAME, expectedDb, 'Unexpected DB_NAME');
    assert.equal((await db.get('SELECT DATABASE() AS name')).name, expectedDb, 'Unexpected connected database');

    const bindings = await db.all(
        `SELECT b.id, b.channel_id, b.status, b.req_mapping, b.resp_mapping,
                c.name AS channel_name, c.base_url
         FROM model_bindings b
         JOIN channels c ON c.id = b.channel_id
         JOIN logical_models lm ON lm.id = b.logical_model_id
         WHERE lm.model_name = 'gpt-image-2'
         ORDER BY b.id`
    );
    assert.ok(bindings.length > 0, 'No gpt-image-2 binding found');

    const targets = [];
    for (const binding of bindings) {
        // 688 渠道有自己的扩展 resp_mapping（多了 base64 归一），不能覆盖成 Klong 那版，
        // 只同步它的 req_mapping。
        const isImg688 = binding.channel_name === img688.CHANNEL_NAME;
        const expectedResp = isImg688 ? img688.resp_mapping : resp_mapping;
        const currentReq = String(binding.req_mapping || '');
        const sameReq = currentReq === req_mapping;
        const sameResp = String(binding.resp_mapping || '') === expectedResp;
        if (sameReq && sameResp) {
            console.log(`binding #${binding.id} ${binding.channel_name}: 已是新映射，跳过`);
            continue;
        }
        if (!allBindings && !SIBLING_REQ_MAPPINGS.has(currentReq)) {
            console.log(`binding #${binding.id} ${binding.channel_name}: 映射非本渠道同源版本，跳过（需要时用 --all-bindings）`);
            continue;
        }
        targets.push({ ...binding, expectedResp, isImg688 });
    }

    if (!targets.length) {
        console.log('没有需要更新的绑定');
        return;
    }

    const conn = await db.pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const binding of targets) {
            console.log(`binding #${binding.id} ${binding.channel_name} (${binding.base_url}) status=${binding.status}: 更新 req_mapping${binding.isImg688 ? ' + 688 扩展 resp_mapping' : ' + resp_mapping'}`);
            if (!dryRun) {
                await conn.execute(
                    'UPDATE model_bindings SET req_mapping = ?, resp_mapping = ? WHERE id = ?',
                    [req_mapping, binding.expectedResp, binding.id]
                );
            }
        }
        if (dryRun) {
            await conn.rollback();
            console.log(JSON.stringify({ dry_run: true, database: expectedDb, updated: targets.map(b => b.id) }));
        } else {
            await conn.commit();
            console.log(JSON.stringify({ applied: true, database: expectedDb, updated: targets.map(b => b.id) }));
        }
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
