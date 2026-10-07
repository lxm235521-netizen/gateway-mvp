// 把 snumom 的 wan3.0-image-prime 逻辑模型与绑定写入网关数据库。
//
// 用法（必须显式指定目标库，避免连错环境）：
//   本地：$env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//         node scripts/add-snumom-wan3-image-prime.js --dry-run   # 只打印将写入/变更的内容
//         node scripts/add-snumom-wan3-image-prime.js --apply     # 实际写入
//   容器内：docker exec <容器名> node scripts/add-snumom-wan3-image-prime.js --apply
//         （容器内同样需要显式设置 EXPECTED_DB_HOST / EXPECTED_DB_NAME）
//
// 只创建/更新逻辑模型和绑定，复用已有渠道，不发起任何付费生成请求。
// 不会删除任何既有模型或绑定，也不覆盖渠道上已有的上游密钥。
const assert = require('node:assert/strict');
const { channel, bindings, model } = require('./snumom-wan3-image-prime-config');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');

const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');

const BINDING_FIELDS = [
    'route_path', 'poll_path', 'is_async', 'proxy_content',
    'error_passthrough', 'poll_throttle', 'weight', 'status'
];

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
            `SELECT id, name, base_url, auth_type, status,
                    api_key IS NOT NULL AND api_key <> '' AS has_api_key
             FROM channels WHERE name = ? OR base_url LIKE ? FOR UPDATE`,
            [channel.name, `%${channel.base_url.replace(/^https?:\/\//, '')}%`]
        );
        assert.equal(channels.length, 1, `Expected exactly one channel for ${channel.name} / ${channel.base_url}, found ${channels.length}`);
        const existingChannel = channels[0];
        assert.equal(existingChannel.name, channel.name, 'Existing channel name differs');
        assert.equal(normalizeBaseUrl(existingChannel.base_url), channel.base_url, 'Existing channel base_url differs');
        assert.equal(existingChannel.auth_type, channel.auth_type, 'Existing channel auth_type differs');
        assert.equal(Number(existingChannel.status), 1, `${existingChannel.name} channel is disabled`);
        if (!existingChannel.has_api_key) {
            console.warn(`[warn] 渠道 ${existingChannel.name} 未配置上游密钥：请在后台填写，或由下游用上游 Key 作为 Bearer 透传。`);
        }

        const saved = [];
        for (const item of bindings) {
            const [existingModels] = await conn.execute(
                'SELECT id FROM logical_models WHERE model_name = ? FOR UPDATE',
                [item.model_name]
            );
            assert.ok(existingModels.length <= 1, `Duplicate logical model ${item.model_name}`);
            let modelId = existingModels[0]?.id;
            if (modelId) {
                console.log(`reuse logical_model #${modelId} ${item.model_name}`);
            } else if (dryRun) {
                console.log(`create logical_model ${item.model_name}`);
            } else {
                const [created] = await conn.execute(
                    'INSERT INTO logical_models (model_name,status,remark) VALUES (?,1,?)',
                    [item.model_name, item.remark]
                );
                modelId = created.insertId;
                console.log(`created logical_model #${modelId} ${item.model_name}`);
            }

            const [existingBindings] = await conn.execute(
                'SELECT * FROM model_bindings WHERE logical_model_id = ? AND channel_id = ? FOR UPDATE',
                [modelId || 0, existingChannel.id]
            );
            assert.ok(existingBindings.length <= 1, `Duplicate binding for ${item.model_name}`);
            const existing = existingBindings[0];

            let bindingId = existing?.id || null;
            if (existing) {
                const updates = [];
                const values = [];
                for (const key of [...BINDING_FIELDS, 'req_mapping', 'resp_mapping', 'poll_mapping']) {
                    const wanted = item[key];
                    const current = existing[key];
                    const same = typeof wanted === 'number'
                        ? Number(current) === wanted
                        : (current === null ? wanted === null : String(current) === String(wanted));
                    if (!same) {
                        updates.push(`${key}=?`);
                        values.push(wanted);
                    }
                }
                if (updates.length) {
                    console.log(`binding #${bindingId} ${item.model_name} differs: ${updates.join(', ')}`);
                    if (!dryRun) {
                        await conn.execute(`UPDATE model_bindings SET ${updates.join(', ')} WHERE id = ?`, [...values, bindingId]);
                    }
                } else {
                    console.log(`binding #${bindingId} ${item.model_name} already up to date`);
                }
            } else if (dryRun) {
                console.log(`create binding ${item.model_name} -> ${channel.base_url}${item.route_path} (poll ${item.poll_path})`);
            } else {
                const [created] = await conn.execute(
                    `INSERT INTO model_bindings
                        (logical_model_id,channel_id,route_path,poll_path,api_key,is_async,proxy_content,error_passthrough,poll_throttle,req_mapping,resp_mapping,poll_mapping,weight,status)
                     VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
                    [
                        modelId, existingChannel.id, item.route_path, item.poll_path,
                        item.is_async, item.proxy_content, item.error_passthrough, item.poll_throttle,
                        item.req_mapping, item.resp_mapping, item.poll_mapping, item.weight, item.status
                    ]
                );
                bindingId = created.insertId;
                console.log(`created binding #${bindingId} ${item.model_name}`);
            }

            if (!dryRun) {
                await conn.execute('UPDATE logical_models SET status = 1, remark = ? WHERE model_name = ?', [item.remark, item.model_name]);
            }
            saved.push({ model: item.model_name, model_id: modelId, binding_id: bindingId });
        }

        if (dryRun) {
            await conn.rollback();
            console.log(JSON.stringify({ dry_run: true, database: expectedDb, host: expectedHost, channel: existingChannel.name, channel_id: existingChannel.id, upstream_model: model.model_name, models: saved }));
        } else {
            await conn.commit();
            console.log(JSON.stringify({ applied: true, database: expectedDb, host: expectedHost, channel: existingChannel.name, channel_id: existingChannel.id, upstream_model: model.model_name, models: saved }));
        }
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
