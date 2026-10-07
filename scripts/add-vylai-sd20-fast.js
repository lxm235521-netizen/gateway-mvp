// 把无阶未来（Vylai）SD 2.0 Fast 模板的逻辑模型与绑定写入网关数据库。三个逻辑模型共用同一上游模板：
//   - 75api-sd20-fast-20260919   通用：resolution 由下游传（480p / 720p，非法回落 480p）
//   - seedance-2.0-933-480p      分辨率由模型名写死 480p
//   - seedance-2.0-933-720p      分辨率由模型名写死 720p
//
// 用法（必须显式指定目标库，避免连错环境）：
//   本地：$env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//         node scripts/add-vylai-sd20-fast.js --dry-run   # 只打印将写入/变更的内容
//         node scripts/add-vylai-sd20-fast.js --apply     # 实际写入
//   容器内：docker exec <容器名> node scripts/add-vylai-sd20-fast.js --apply
//         （容器内同样需要显式设置 EXPECTED_DB_HOST / EXPECTED_DB_NAME）
//
// 复用已有渠道「Vylai MiniMax H3」（https://queueapi.vylai.com，X-Auth-Token 鉴权，
// 与 75api-minimax-h3-* 三个绑定同一渠道同一密钥）：
// 只新增逻辑模型与绑定，不新建渠道、不修改渠道密钥、不删除任何既有记录，
// 重复执行只更新差异字段，不会重复添加。
const assert = require('node:assert/strict');
const { channel, bindings, TEMPLATE_KEY } = require('./vylai-sd20-fast-config');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');

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
        assert.equal(existingChannel.auth_type, channel.auth_type, 'Existing channel auth_type differs');
        assert.equal(Number(existingChannel.status), 1, `${existingChannel.name} channel is disabled`);
        if (!existingChannel.has_api_key) {
            console.warn(`[warn] 渠道 ${existingChannel.name} 未配置上游密钥：请在后台填写，或用下游上游 Key 透传。`);
        }
        console.log(`reuse channel #${existingChannel.id} ${existingChannel.name} ${existingChannel.base_url} (auth ${existingChannel.auth_type})`);
        console.log(`上游模板: ${TEMPLATE_KEY}`);

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
            saved.push({ model: item.model_name, upstream_template: TEMPLATE_KEY, model_id: modelId, binding_id: bindingId });
        }

        const summary = {
            database: expectedDb,
            host: expectedHost,
            channel: existingChannel.name,
            channel_id: existingChannel.id,
            upstream_template: TEMPLATE_KEY,
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
