// 把佳速 MiniMax H3（minimax-h3-933-2k-支持真人）逻辑模型与绑定写入网关数据库。
//
// 用法（必须显式指定目标库，避免连错环境）：
//   $env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//   node scripts/add-jiasu-minimax-h3.js --dry-run   # 只打印将写入/变更的内容
//   node scripts/add-jiasu-minimax-h3.js --apply     # 实际写入
//
// 复用已有渠道「佳速 Seedance」（https://ai.jiasuapi.com/v1，同一 key），
// 只新增逻辑模型与绑定；不修改渠道密钥，不删除任何既有记录，重复执行不重复添加。
// 上游模型名可用 MINIMAX_H3_MODEL_NAME 覆盖（见配置文件里的「模型可用性」说明）。
const assert = require('node:assert/strict');
const { channel, bindings, models, MODEL_NAME } = require('./jiasu-minimax-h3-config');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');

// 逻辑模型改名后，旧名字只出现在 models 里；按 model_name 取回旧名字用于复用。
const legacyNamesByModel = new Map(
    models.map(model => [model.model_name, model.legacy_model_names || []])
);

const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');

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

async function main() {
    const expectedHost = process.env.EXPECTED_DB_HOST;
    const expectedDb = process.env.EXPECTED_DB_NAME;
    assert.ok(expectedHost && expectedDb, 'Set EXPECTED_DB_HOST and EXPECTED_DB_NAME explicitly');
    assert.equal(process.env.DB_HOST, expectedHost, 'Unexpected DB_HOST');
    assert.equal(process.env.DB_NAME, expectedDb, 'Unexpected DB_NAME');
    assert.equal((await db.get('SELECT DATABASE() AS name')).name, expectedDb, 'Unexpected connected database');

    console.log(`上游模型名: ${MODEL_NAME}`);

    const conn = await db.pool.getConnection();
    try {
        await conn.beginTransaction();

        const [channels] = await conn.execute(
            `SELECT id, name, base_url, auth_type, status,
                    api_key IS NOT NULL AND api_key <> '' AS has_api_key
             FROM channels WHERE name = ? OR base_url = ? FOR UPDATE`,
            [channel.name, channel.base_url]
        );
        assert.equal(channels.length, 1, `Expected exactly one channel for ${channel.name} / ${channel.base_url}, found ${channels.length}`);
        const existingChannel = channels[0];
        assert.equal(existingChannel.name, channel.name, 'Existing channel name differs');
        assert.equal(normalizeBaseUrl(existingChannel.base_url), channel.base_url, 'Existing channel base_url differs');
        if (!existingChannel.has_api_key) {
            console.warn(`[warn] 渠道 ${existingChannel.name} 未配置上游密钥：请在后台填写，或用下游 Bearer Key 透传。`);
        }
        console.log(`reuse channel #${existingChannel.id} ${existingChannel.name} ${existingChannel.base_url}`);

        const saved = [];
        for (const item of bindings) {
            const [existingModels] = await conn.execute(
                'SELECT id FROM logical_models WHERE model_name = ? FOR UPDATE',
                [item.model_name]
            );
            assert.ok(existingModels.length <= 1, `Duplicate logical model ${item.model_name}`);
            let modelId = existingModels[0]?.id;

            // 逻辑模型改过名时复用旧记录，避免同一上游模型留下两条记录。
            const legacyNames = legacyNamesByModel.get(item.model_name) || [];
            if (!modelId && legacyNames.length) {
                const placeholders = legacyNames.map(() => '?').join(',');
                const [legacyModels] = await conn.execute(
                    `SELECT id, model_name FROM logical_models WHERE model_name IN (${placeholders}) FOR UPDATE`,
                    legacyNames
                );
                assert.ok(legacyModels.length <= 1, `Multiple legacy logical models for ${item.model_name}`);
                if (legacyModels.length) {
                    modelId = legacyModels[0].id;
                    console.log(`rename logical_model #${modelId} ${legacyModels[0].model_name} -> ${item.model_name}`);
                    if (!dryRun) {
                        await conn.execute('UPDATE logical_models SET model_name = ? WHERE id = ?', [item.model_name, modelId]);
                    }
                }
            }

            if (modelId) {
                if (existingModels[0]?.id === modelId) {
                    console.log(`reuse logical_model #${modelId} ${item.model_name}`);
                }
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
            saved.push({ model: item.model_name, upstream_model: MODEL_NAME, model_id: modelId, binding_id: bindingId });
        }

        const summary = {
            database: expectedDb,
            host: expectedHost,
            channel: existingChannel.name,
            channel_id: existingChannel.id,
            models: saved
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
