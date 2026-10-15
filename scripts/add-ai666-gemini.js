// 新建渠道 AI666 Gemini（https://ai666.live，Bearer），新增逻辑模型 gemini-4-argon 与绑定。
//
// 上游是 Gemini 原生协议（new-api 网关）：
//   非流式 POST /v1beta/models/gemini-4-argon:generateContent
//   流式   POST /v1beta/models/gemini-4-argon:generateContent?alt=sse（网关原样透传 SSE）
// 映射把下游 OpenAI 协议（/v1/chat/completions）转成 Gemini 报文，详见
// scripts/ai666-gemini-config.js 顶部注释。
//
// 用法（必须显式指定目标库，避免连错环境）：
//   $env:EXPECTED_DB_HOST='154.36.173.77'; $env:EXPECTED_DB_NAME='gateway'
//   node scripts/add-ai666-gemini.js --dry-run   # 只打印将写入/变更的内容（默认）
//   node scripts/add-ai666-gemini.js --apply     # 实际写入
//
// 幂等：渠道按 name / base_url 复用，逻辑模型按 model_name 复用，绑定按（逻辑模型，渠道）复用；
// 已存在的渠道密钥不会被覆盖，重复执行只更新差异字段。
const assert = require('node:assert/strict');
const { channel, bindings } = require('./ai666-gemini-config');
const db = require('../db');

const dryRun = !process.argv.includes('--apply');

const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');

const BINDING_FIELDS = [
    'route_path', 'poll_path', 'is_async', 'proxy_content',
    'error_passthrough', 'poll_throttle', 'weight', 'status',
    'req_mapping', 'resp_mapping', 'poll_mapping'
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
            `SELECT id, name, base_url, auth_type, status, convert_base64_to_url, convert_resp_base64_to_url,
                    api_key IS NOT NULL AND api_key <> '' AS has_api_key
             FROM channels WHERE name = ? OR base_url = ? FOR UPDATE`,
            [channel.name, channel.base_url]
        );
        assert.ok(channels.length <= 1, `Multiple channels match ${channel.name} / ${channel.base_url}; inspect before changing`);

        let channelId;
        if (channels.length === 1) {
            const existing = channels[0];
            assert.equal(existing.name, channel.name, 'Existing channel name differs');
            assert.equal(normalizeBaseUrl(existing.base_url), channel.base_url, 'Existing channel base_url differs');
            assert.equal(existing.auth_type, channel.auth_type, 'Existing channel auth_type differs');
            channelId = existing.id;
            console.log(`reuse channel #${channelId} ${existing.name} ${existing.base_url} (auth ${existing.auth_type}, key=${existing.has_api_key ? 'set' : 'missing'})`);
            if (!existing.has_api_key) {
                if (dryRun) {
                    console.log(`channel #${channelId} would receive the configured api_key`);
                } else {
                    await conn.execute('UPDATE channels SET api_key = ? WHERE id = ?', [channel.api_key, channelId]);
                    console.log(`channel #${channelId} api_key updated`);
                }
            }
            for (const [column, value] of [
                ['convert_base64_to_url', channel.convert_base64_to_url],
                ['convert_resp_base64_to_url', channel.convert_resp_base64_to_url]
            ]) {
                if (Number(existing[column]) !== Number(value)) {
                    if (dryRun) {
                        console.log(`channel #${channelId} would set ${column} = ${value}`);
                    } else {
                        await conn.execute(`UPDATE channels SET ${column} = ? WHERE id = ?`, [value, channelId]);
                        console.log(`channel #${channelId} ${column} = ${value}`);
                    }
                }
            }
        } else if (dryRun) {
            console.log(`create channel ${channel.name} ${channel.base_url} (auth ${channel.auth_type}, key set)`);
        } else {
            const [created] = await conn.execute(
                'INSERT INTO channels (name,base_url,auth_type,api_key,status,convert_base64_to_url,convert_resp_base64_to_url) VALUES (?,?,?,?,1,?,?)',
                [channel.name, channel.base_url, channel.auth_type, channel.api_key, channel.convert_base64_to_url, channel.convert_resp_base64_to_url]
            );
            channelId = created.insertId;
            console.log(`created channel #${channelId} ${channel.name}`);
        }

        const saved = [];
        for (const item of bindings) {
            const [existingModels] = await conn.execute(
                'SELECT id, remark FROM logical_models WHERE model_name = ? FOR UPDATE',
                [item.model_name]
            );
            assert.ok(existingModels.length <= 1, `Duplicate logical model ${item.model_name}`);
            let modelId = existingModels[0]?.id;

            if (modelId) {
                console.log(`reuse logical_model #${modelId} ${item.model_name}`);
                if (!dryRun) {
                    await conn.execute('UPDATE logical_models SET status = 1, remark = ? WHERE id = ?', [item.remark, modelId]);
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
                [modelId || 0, channelId || 0]
            );
            assert.ok(existingBindings.length <= 1, `Duplicate binding for ${item.model_name} on channel #${channelId}`);
            const existing = existingBindings[0];

            let bindingId = existing?.id || null;
            if (existing) {
                const updates = [];
                const values = [];
                for (const key of BINDING_FIELDS) {
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
                console.log(`create binding ${item.model_name} -> ${channel.base_url}${item.route_path}（stream=true 时改走 ?alt=sse 并透传）`);
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

            saved.push({ model: item.model_name, model_id: modelId, binding_id: bindingId });
        }

        const summary = {
            database: expectedDb,
            host: expectedHost,
            channel: channel.name,
            channel_id: channelId,
            base_url: channel.base_url,
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
