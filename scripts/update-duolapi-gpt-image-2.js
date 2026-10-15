// 把 scripts/duolapi-gpt-image-2-config.js 的映射写入渠道 gpt-image-duolapi（#40）
// 上 gpt-image-2 的绑定：文生图改走 POST /v1/images/generations（JSON + prompt），
// 图生图仍是 POST /v1/images/edits（multipart）。
//
// 用法（必须显式指定目标库，避免连错环境）：
//   $env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//   node scripts/update-duolapi-gpt-image-2.js --dry-run   # 只打印将变更的内容（默认）
//   node scripts/update-duolapi-gpt-image-2.js --apply     # 实际写入
//
// 安全边界：
//   - 渠道按 name / base_url 复用，绑定按（逻辑模型 gpt-image-2，渠道 #40）定位；
//     两者都必须唯一命中，否则直接报错、不做任何写入。
//   - 默认只更新「当前 req_mapping / resp_mapping 是本渠道登记过的版本」的绑定，
//     避免误伤别人手改过的映射；确实要强写时加 --force。
//   - 只改该绑定的 req_mapping / resp_mapping 与该渠道的 convert_resp_base64_to_url，
//     不动 status / weight / 密钥，也不影响其它渠道的 gpt-image-2 绑定。
//   - 重复执行只更新差异字段（幂等）。
const assert = require('node:assert/strict');
const db = require('../db');
const cfg = require('./duolapi-gpt-image-2-config');

const dryRun = !process.argv.includes('--apply');
const force = process.argv.includes('--force');

const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');
const KNOWN_REQ = new Set([cfg.req_mapping, ...cfg.legacy_req_mappings]);
const KNOWN_RESP = new Set([cfg.resp_mapping, ...cfg.legacy_resp_mappings]);

const sameValue = (wanted, current) => {
    if (wanted === null || wanted === undefined) {
        return current === null || current === undefined;
    }
    if (typeof wanted === 'number') {
        return Number(current) === wanted;
    }
    return current !== null && current !== undefined && String(current) === String(wanted);
};

async function main() {
    const expectedHost = process.env.EXPECTED_DB_HOST;
    const expectedDb = process.env.EXPECTED_DB_NAME;
    assert.ok(expectedHost && expectedDb, 'Set EXPECTED_DB_HOST and EXPECTED_DB_NAME explicitly');
    assert.equal(process.env.DB_HOST, expectedHost, 'Unexpected DB_HOST');
    assert.equal(process.env.DB_NAME, expectedDb, 'Unexpected DB_NAME');
    assert.equal((await db.get('SELECT DATABASE() AS name')).name, expectedDb, 'Unexpected connected database');

    const conn = await db.pool.getConnection();
    try {
        await conn.beginTransaction();

        const [channels] = await conn.execute(
            'SELECT id, name, base_url, auth_type, convert_resp_base64_to_url FROM channels WHERE name = ? OR base_url = ? FOR UPDATE',
            [cfg.channel.name, cfg.channel.base_url]
        );
        assert.equal(channels.length, 1, `Expected exactly one channel ${cfg.channel.name} / ${cfg.channel.base_url}, got ${channels.length}`);
        const channel = channels[0];
        assert.equal(channel.name, cfg.channel.name, 'Channel name differs');
        assert.equal(normalizeBaseUrl(channel.base_url), cfg.channel.base_url, 'Channel base_url differs');
        assert.equal(channel.auth_type, cfg.channel.auth_type, 'Channel auth_type differs');

        const [models] = await conn.execute('SELECT id FROM logical_models WHERE model_name = ? FOR UPDATE', [cfg.channel.logical_model]);
        assert.equal(models.length, 1, `Expected exactly one logical model ${cfg.channel.logical_model}`);
        const modelId = models[0].id;

        const [bindings] = await conn.execute(
            'SELECT * FROM model_bindings WHERE logical_model_id = ? AND channel_id = ? FOR UPDATE',
            [modelId, channel.id]
        );
        assert.equal(bindings.length, 1, `Expected exactly one binding for ${cfg.channel.logical_model} on channel #${channel.id}`);
        const binding = bindings[0];

        if (!force) {
            assert.ok(
                KNOWN_REQ.has(binding.req_mapping),
                `binding #${binding.id} 的 req_mapping 不是本渠道登记过的版本；确认无误后加 --force 强写`
            );
        }

        const bindingUpdates = [];
        const bindingValues = [];
        for (const [key, wanted] of [['req_mapping', cfg.req_mapping], ['resp_mapping', cfg.resp_mapping]]) {
            if (!sameValue(wanted, binding[key])) {
                bindingUpdates.push(`${key}=?`);
                bindingValues.push(wanted);
            }
        }

        console.log(`channel #${channel.id} ${channel.name} ${channel.base_url}`);
        console.log(`binding #${binding.id} ${cfg.channel.logical_model} -> ${cfg.channel.text_route_path}(文生图) / ${cfg.channel.image_route_path}(图生图) status=${binding.status}`);

        if (bindingUpdates.length) {
            console.log(`binding #${binding.id} would update: ${bindingUpdates.map(item => item.replace('=?', '')).join(', ')}`);
            if (!dryRun) {
                await conn.execute(`UPDATE model_bindings SET ${bindingUpdates.join(', ')} WHERE id = ?`, [...bindingValues, binding.id]);
                console.log(`binding #${binding.id} updated`);
            }
        } else {
            console.log(`binding #${binding.id} req_mapping / resp_mapping 已是最新`);
        }

        if (Number(channel.convert_resp_base64_to_url) !== 1) {
            console.log(`channel #${channel.id} would set convert_resp_base64_to_url = 1（上游只回 b64_json 时换图床链接）`);
            if (!dryRun) {
                await conn.execute('UPDATE channels SET convert_resp_base64_to_url = 1 WHERE id = ?', [channel.id]);
                console.log(`channel #${channel.id} convert_resp_base64_to_url = 1`);
            }
        }

        const summary = {
            database: expectedDb,
            channel: channel.name,
            channel_id: channel.id,
            binding_id: binding.id,
            logical_model: cfg.channel.logical_model,
            text_route_path: cfg.channel.text_route_path,
            image_route_path: cfg.channel.image_route_path,
            changed: bindingUpdates.length > 0 || Number(channel.convert_resp_base64_to_url) !== 1
        };
        if (dryRun) {
            await conn.rollback();
            console.log(JSON.stringify({ dry_run: true, ...summary }));
        } else {
            await conn.commit();
            console.log(JSON.stringify({ applied: true, ...summary }));
        }
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
