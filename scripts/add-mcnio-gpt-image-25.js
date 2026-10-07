// 把 MCNIO GPT Image 2.5（Sunburst / Flare）的两个逻辑模型与绑定写入网关数据库。
//
// 用法：显式指定目标库，避免连错环境。
//   Windows / 本地：
//     $env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//     node scripts/add-mcnio-gpt-image-25.js --dry-run   # 只打印将写入的内容
//     node scripts/add-mcnio-gpt-image-25.js --apply     # 实际写入
//   Docker 容器内（复用容器实际的数据库环境变量）：
//     docker exec <容器名> node scripts/add-mcnio-gpt-image-25.js --apply
//     容器内仍需显式提供 EXPECTED_DB_HOST / EXPECTED_DB_NAME。
//
// 只创建/更新渠道、逻辑模型和绑定，不发起任何付费生成请求。
// 渠道已存在同名（MCNIO GPT Image）时复用，不重复创建；api_key 保持原样（不覆盖已有密钥）。
const assert = require('node:assert/strict');
const { channel, bindings, models } = require('./mcnio-gpt-image-25-config');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');

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
            'SELECT id,name,base_url,auth_type,status FROM channels WHERE name=? OR base_url=? FOR UPDATE',
            [channel.name, channel.base_url]
        );
        assert.ok(channels.length <= 1, 'Multiple matching channels; inspect before changing');
        let channelId;
        if (channels.length) {
            assert.equal(channels[0].base_url, channel.base_url, 'Existing channel base_url differs');
            assert.equal(channels[0].auth_type, channel.auth_type, 'Existing channel auth_type differs');
            channelId = channels[0].id;
            console.log(`reuse channel #${channelId} ${channels[0].name} ${channels[0].base_url}`);
        } else if (dryRun) {
            channelId = null;
            console.log(`create channel ${channel.name} ${channel.base_url} (${channel.auth_type})`);
        } else {
            const [created] = await conn.execute(
                'INSERT INTO channels (name,base_url,auth_type,api_key,status) VALUES (?,?,?,NULL,1)',
                [channel.name, channel.base_url, channel.auth_type]
            );
            channelId = created.insertId;
            console.log(`created channel #${channelId} ${channel.name}`);
        }

        const saved = [];
        for (const item of bindings) {
            let [existingModels] = await conn.execute('SELECT id,remark FROM logical_models WHERE model_name=?', [item.model_name]);
            let modelId = existingModels[0]?.id;
            if (!modelId) {
                if (dryRun) {
                    console.log(`create logical_model ${item.model_name}`);
                } else {
                    const [created] = await conn.execute(
                        'INSERT INTO logical_models (model_name,status,remark) VALUES (?,1,?)',
                        [item.model_name, item.remark]
                    );
                    modelId = created.insertId;
                    console.log(`created logical_model #${modelId} ${item.model_name}`);
                }
            } else if (dryRun) {
                console.log(`reuse logical_model #${modelId} ${item.model_name}`);
            }

            let bindingId = null;
            if (channelId && modelId) {
                const [existingBindings] = await conn.execute(
                    'SELECT id,route_path,poll_path,is_async,proxy_content,error_passthrough,status,req_mapping,resp_mapping FROM model_bindings WHERE logical_model_id=? AND channel_id=?',
                    [modelId, channelId]
                );
                assert.ok(existingBindings.length <= 1, 'Duplicate binding');
                const existing = existingBindings[0];
                if (existing) {
                    bindingId = existing.id;
                    const updates = [];
                    const values = [];
                    for (const [key, wanted] of Object.entries({
                        route_path: item.route_path,
                        is_async: item.is_async,
                        proxy_content: item.proxy_content,
                        req_mapping: item.req_mapping,
                        resp_mapping: item.resp_mapping
                    })) {
                        const current = existing[key];
                        const same = typeof wanted === 'number'
                            ? Number(current) === wanted
                            : String(current || '') === String(wanted);
                        if (!same) {
                            updates.push(`${key}=?`);
                            values.push(wanted);
                        }
                    }
                    if (Number(existing.status) !== 1) {
                        updates.push('status=?');
                        values.push(1);
                    }
                    if (updates.length) {
                        console.log(`binding #${bindingId} ${item.model_name} differs in: ${updates.join(', ')}`);
                        if (!dryRun) {
                            await conn.execute(`UPDATE model_bindings SET ${updates.join(', ')} WHERE id=?`, [...values, bindingId]);
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
                         VALUES (?,?,?,?,NULL,?,?,1,0,?,?,NULL,1,1)`,
                        [modelId, channelId, item.route_path, item.poll_path, item.is_async, item.proxy_content, item.req_mapping, item.resp_mapping]
                    );
                    bindingId = created.insertId;
                    console.log(`created binding #${bindingId} ${item.model_name}`);
                }
            }

            if (!dryRun) {
                await conn.execute('UPDATE logical_models SET remark=?, status=1 WHERE model_name=?', [item.remark, item.model_name]);
            }
            saved.push({ model: item.model_name, tier: models.find(model => model.model_name === item.model_name)?.tier, model_id: modelId, binding_id: bindingId });
        }

        // 只创建/复用，不删除任何既有模型或绑定。
        if (dryRun) {
            await conn.rollback();
            console.log(JSON.stringify({ dry_run: true, database: expectedDb, host: expectedHost, channel: channel.name, channel_id: channelId, models: saved }));
        } else {
            await conn.commit();
            console.log(JSON.stringify({ applied: true, database: expectedDb, host: expectedHost, channel: channel.name, channel_id: channelId, models: saved }));
        }
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
