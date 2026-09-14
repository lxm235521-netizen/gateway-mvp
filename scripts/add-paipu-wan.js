// Run inside the gateway container so the script uses the live database environment.
const assert = require('node:assert/strict');
const { channel, bindings } = require('./paipu-wan-config');
const db = require('../db');

const normalizeBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');

async function main() {
    const expectedHost = process.env.EXPECTED_DB_HOST;
    const expectedDb = process.env.EXPECTED_DB_NAME;
    assert.ok(expectedHost && expectedDb, 'Set EXPECTED_DB_HOST and EXPECTED_DB_NAME explicitly');
    assert.equal(process.env.DB_HOST, expectedHost, 'Unexpected DB_HOST');
    assert.equal(process.env.DB_NAME, expectedDb, 'Unexpected DB_NAME');
    assert.equal((await db.get('SELECT DATABASE() AS name')).name, expectedDb);

    const conn = await db.pool.getConnection();
    try {
        await conn.beginTransaction();

        const [channels] = await conn.execute(
            `SELECT id, name, base_url, auth_type, status,
                    api_key IS NOT NULL AND api_key <> '' AS has_api_key
             FROM channels WHERE name = ? FOR UPDATE`,
            [channel.name]
        );
        assert.equal(channels.length, 1, `Expected exactly one existing channel named ${channel.name}`);
        const existingChannel = channels[0];
        assert.equal(normalizeBaseUrl(existingChannel.base_url), channel.base_url);
        assert.equal(existingChannel.auth_type, channel.auth_type);
        assert.equal(existingChannel.status, 1, 'Paipu Video channel is disabled');
        assert.equal(existingChannel.has_api_key, 1, 'Paipu Video channel has no upstream API key');

        const saved = [];
        for (const item of bindings) {
            let [models] = await conn.execute(
                'SELECT id FROM logical_models WHERE model_name = ? FOR UPDATE',
                [item.model_name]
            );
            let modelId = models[0]?.id;
            if (!modelId) {
                const [created] = await conn.execute(
                    'INSERT INTO logical_models (model_name, status, remark) VALUES (?, 1, ?)',
                    [item.model_name, item.remark]
                );
                modelId = created.insertId;
            } else {
                await conn.execute(
                    'UPDATE logical_models SET status = 1, remark = ? WHERE id = ?',
                    [item.remark, modelId]
                );
            }

            const [existing] = await conn.execute(
                `SELECT id, route_path, poll_path, is_async, proxy_content,
                        error_passthrough, poll_throttle, req_mapping, resp_mapping,
                        poll_mapping, weight, status
                 FROM model_bindings
                 WHERE logical_model_id = ? AND channel_id = ? FOR UPDATE`,
                [modelId, existingChannel.id]
            );
            assert.ok(existing.length <= 1, `Duplicate binding for ${item.model_name}`);

            let bindingId = existing[0]?.id;
            if (bindingId) {
                for (const key of [
                    'route_path', 'poll_path', 'is_async', 'proxy_content',
                    'error_passthrough', 'poll_throttle', 'req_mapping',
                    'resp_mapping', 'poll_mapping', 'weight', 'status'
                ]) {
                    assert.equal(existing[0][key], item[key], `Existing ${item.model_name} binding differs: ${key}`);
                }
            } else {
                const [created] = await conn.execute(
                    `INSERT INTO model_bindings
                     (logical_model_id, channel_id, route_path, poll_path, api_key,
                      is_async, proxy_content, error_passthrough, poll_throttle,
                      req_mapping, resp_mapping, poll_mapping, weight, status)
                     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        modelId, existingChannel.id, item.route_path, item.poll_path,
                        item.is_async, item.proxy_content, item.error_passthrough,
                        item.poll_throttle, item.req_mapping, item.resp_mapping,
                        item.poll_mapping, item.weight, item.status
                    ]
                );
                bindingId = created.insertId;
            }
            saved.push({ model: item.model_name, model_id: modelId, binding_id: bindingId });
        }

        await conn.commit();
        console.log(JSON.stringify({
            database: expectedDb,
            host: expectedHost,
            channel_id: existingChannel.id,
            channel: channel.name,
            models: saved
        }));
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

main()
    .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(() => db.pool.end());
