const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const { once } = require('node:events');

function createFixture() {
    const channels = new Map([[1, { id: 1, status: 1 }]]);
    const models = new Map([[1, { id: 1, status: 1 }]]);
    const keys = new Map([[1, { id: 1, status: 1 }]]);
    let activeBindings = 1;
    const activeTasks = { model: 1, key: 1 };
    const writes = [];
    const db = {
        async get(sql, params = []) {
            const id = Number(params[0]);
            if (sql.includes("FROM channels WHERE id")) return channels.get(id) || null;
            if (sql.includes("FROM logical_models WHERE id")) return models.get(id) || null;
            if (sql.includes("FROM gateway_keys WHERE id")) return keys.get(id) || null;
            if (sql.includes("FROM model_bindings")) return { count: activeBindings };
            if (sql.includes("FROM async_tasks") && sql.includes("logical_model_id")) return { count: activeTasks.model };
            if (sql.includes("FROM async_tasks") && sql.includes("gw_key_id")) return { count: activeTasks.key };
            throw new Error(`Unexpected query: ${sql}`);
        },
        async all() { return []; },
        async run(sql, params = []) {
            writes.push({ sql, params });
            const id = Number(params.at(-1));
            if (sql.includes("UPDATE channels")) channels.get(id).status = 0;
            if (sql.includes("UPDATE logical_models")) models.get(id).status = 0;
            if (sql.includes("UPDATE gateway_keys")) keys.get(id).status = 0;
            return { affectedRows: 1 };
        }
    };
    return { db, channels, models, keys, activeTasks, setActiveBindings(value) { activeBindings = value; }, writes };
}

test('admin delete endpoints require auth and soft-delete safe records', async t => {
    const fixture = createFixture();
    const app = express();
    app.use(express.json());
    app.use('/admin', require('../admin-api')(fixture.db));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = crypto.createHash('sha256').update(process.env.ADMIN_PASS || 'admin-password').digest('hex');
    const headers = { Authorization: `Bearer ${token}` };

    for (const path of ['/admin/models/1', '/admin/channels/1', '/admin/keys/1']) {
        const response = await fetch(base + path, { method: 'DELETE' });
        assert.equal(response.status, 401);
    }

    let response = await fetch(base + '/admin/models/1', { method: 'DELETE', headers });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /进行中的任务/);
    fixture.activeTasks.model = 0;
    response = await fetch(base + '/admin/models/1', { method: 'DELETE', headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 0);
    assert.equal(fixture.models.get(1).status, 0);

    response = await fetch(base + '/admin/channels/1', { method: 'DELETE', headers });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /模型绑定/);
    fixture.setActiveBindings(0);
    response = await fetch(base + '/admin/channels/1', { method: 'DELETE', headers });
    assert.equal(response.status, 200);
    assert.equal(fixture.channels.get(1).status, 0);

    response = await fetch(base + '/admin/keys/1', { method: 'DELETE', headers });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /关联中的任务/);
    fixture.activeTasks.key = 0;
    response = await fetch(base + '/admin/keys/1', { method: 'DELETE', headers });
    assert.equal(response.status, 200);
    assert.equal(fixture.keys.get(1).status, 0);
    assert.equal(fixture.writes.length, 3);
});
