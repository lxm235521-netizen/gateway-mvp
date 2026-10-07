// 把 gpt-image-2.5 的新渠道（http://38.127.51.106:4599）与绑定写入网关数据库。
//
// 用法（必须显式指定目标库，避免连错环境）：
//   $env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//   node scripts/add-gpt-image-25-new-channel.js --dry-run   # 只打印将写入/变更的内容
//   node scripts/add-gpt-image-25-new-channel.js --apply     # 实际写入
//
// 逻辑模型 gpt-image-2.5 已存在（渠道 #15 在用），脚本只新增渠道 + 绑定，
// 让同一逻辑模型多一个上游渠道；绑定之间不需要权重调整就自然分流。
// 只创建/更新渠道与绑定，不发起任何付费生成请求，也不删除任何既有记录。
// 渠道已有密钥时不覆盖（避免冲掉后台改过的 Key）。
const assert = require('node:assert/strict');
const { channels, channel, bindings } = require('./gpt-image-25-new-channel-config');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');

const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');

const CHANNEL_FIELDS = ['name', 'base_url', 'auth_type', 'status'];
const BINDING_FIELDS = [
    'route_path', 'poll_path', 'is_async', 'proxy_content',
    'error_passthrough', 'poll_throttle', 'weight', 'status'
];

function sameValue(wanted, current) {
    if (wanted === null || wanted === undefined) {
        return current === null || current === undefined;
    }
    if (typeof wanted === 'number') {
        return Number(current) === wanted;
    }
    return current !== null && current !== undefined && String(current) === String(wanted);
}

async function ensureChannel(conn) {
    const [rows] = await conn.execute(
        `SELECT id, name, base_url, auth_type, status,
                api_key IS NOT NULL AND api_key <> '' AS has_api_key
         FROM channels WHERE name = ? OR base_url = ? FOR UPDATE`,
        [channel.name, channel.base_url]
    );
    assert.ok(rows.length <= 1, `Expected at most one channel for ${channel.name} / ${channel.base_url}, found ${rows.length}`);

    if (!rows.length) {
        if (dryRun) {
            console.log(`create channel ${channel.name} ${channel.base_url} (${channel.auth_type})`);
            return { id: null, name: channel.name, created: true };
        }
        const [created] = await conn.execute(
            'INSERT INTO channels (name,base_url,auth_type,api_key,status) VALUES (?,?,?,?,1)',
            [channel.name, channel.base_url, channel.auth_type, channel.api_key || null]
        );
        console.log(`created channel #${created.insertId} ${channel.name}`);
        return { id: created.insertId, name: channel.name, created: true };
    }

    const existing = rows[0];
    assert.equal(normalizeBaseUrl(existing.base_url), channel.base_url, 'Existing channel base_url differs');
    const updates = [];
    const values = [];
    for (const key of CHANNEL_FIELDS) {
        if (key === 'base_url') {
            continue;
        }
        if (!sameValue(channel[key], existing[key])) {
            updates.push(`${key}=?`);
            values.push(channel[key]);
        }
    }
    if (!existing.has_api_key && channel.api_key) {
        updates.push('api_key=?');
        values.push(channel.api_key);
        console.log(`channel #${existing.id} 当前无密钥，补写渠道默认密钥`);
    } else if (existing.has_api_key) {
        console.log(`channel #${existing.id} 已有密钥，保持原样不覆盖`);
    }
    if (updates.length) {
        console.log(`channel #${existing.id} ${channel.name} differs: ${updates.join(', ')}`);
        if (!dryRun) {
            await conn.execute(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`, [...values, existing.id]);
        }
    } else {
        console.log(`reuse channel #${existing.id} ${existing.name} ${existing.base_url}`);
    }
    return { id: existing.id, name: existing.name, created: false };
}

async function main() {
    const expectedHost = process.env.EXPECTED_DB_HOST;
    const expectedDb = process.env.EXPECTED_DB_NAME;
    assert.ok(expectedHost && expectedDb, 'Set EXPECTED_DB_HOST and EXPECTED_DB_NAME explicitly');
    assert.equal(process.env.DB_HOST, expectedHost, 'Unexpected DB_HOST');
    assert.equal(process.env.DB_NAME, expectedDb, 'Unexpected DB_NAME');
    assert.equal((await db.get('SELECT DATABASE() AS name')).name, expectedDb, 'Unexpected connected database');
    assert.equal(channels.length, 1, 'This script expects exactly one channel definition');

    const conn = await db.pool.getConnection();
    try {
        await conn.beginTransaction();

        const savedChannel = await ensureChannel(conn);
        const channelId = savedChannel.id;

        const savedBindings = [];
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
                [modelId || 0, channelId || 0]
            );
            assert.ok(existingBindings.length <= 1, `Duplicate binding for ${item.model_name}`);
            const existing = existingBindings[0];

            let bindingId = existing?.id || null;
            if (existing) {
                const updates = [];
                const values = [];
                for (const key of [...BINDING_FIELDS, 'req_mapping', 'resp_mapping', 'poll_mapping']) {
                    if (!sameValue(item[key], existing[key])) {
                        updates.push(`${key}=?`);
                        values.push(item[key]);
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
                console.log(`create binding ${item.model_name} -> ${channel.base_url}${item.route_path}`);
            } else {
                const [created] = await conn.execute(
                    `INSERT INTO model_bindings
                        (logical_model_id,channel_id,route_path,poll_path,api_key,is_async,proxy_content,error_passthrough,poll_throttle,req_mapping,resp_mapping,poll_mapping,weight,status)
                     VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
                    [
                        modelId, channelId, item.route_path, item.poll_path,
                        item.is_async, item.proxy_content, item.error_passthrough, item.poll_throttle,
                        item.req_mapping, item.resp_mapping, item.poll_mapping, item.weight, item.status
                    ]
                );
                bindingId = created.insertId;
                console.log(`created binding #${bindingId} ${item.model_name}`);
            }

            // 逻辑模型可能被其它渠道共用，只补 remark，不覆盖为空。
            if (!dryRun) {
                await conn.execute(
                    'UPDATE logical_models SET status = 1, remark = COALESCE(NULLIF(remark, \'\'), ?) WHERE model_name = ?',
                    [item.remark, item.model_name]
                );
            }
            savedBindings.push({ model: item.model_name, model_id: modelId, binding_id: bindingId });
        }

        const summary = {
            database: expectedDb,
            host: expectedHost,
            channels: [savedChannel],
            models: savedBindings
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
