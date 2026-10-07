// 一次性清理：MiniMax H3 逻辑模型改名（minimax-h3-933-2k-支持真人 -> minimax-h3-2k）时，
// 配置脚本因旧名字未传递而新建了重复记录，这里把旧模型与其绑定删掉。
//
// 只删除明确指定的两条（旧逻辑模型 + 挂在它上面的绑定），并且要求：
//   - 该逻辑模型当前名字必须是 OLD_MODEL_NAME（避免误删已被改名的记录）
//   - 保留的 NEW_MODEL_NAME 记录必须存在
//   - 没有任何 async_tasks 引用待删对象
// 用法：$env:EXPECTED_DB_HOST=...; $env:EXPECTED_DB_NAME=...
//   node scripts/cleanup-jiasu-minimax-duplicate.js --dry-run | --apply
const assert = require('node:assert/strict');
const db = require('../db');

const OLD_MODEL_NAME = 'minimax-h3-933-2k-支持真人';
const NEW_MODEL_NAME = 'minimax-h3-2k';
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

        const [keepModels] = await conn.execute('SELECT id FROM logical_models WHERE model_name = ? FOR UPDATE', [NEW_MODEL_NAME]);
        assert.equal(keepModels.length, 1, `Expected exactly one ${NEW_MODEL_NAME}, found ${keepModels.length}`);
        const keepId = keepModels[0].id;

        const [oldModels] = await conn.execute('SELECT id FROM logical_models WHERE model_name = ? FOR UPDATE', [OLD_MODEL_NAME]);
        if (!oldModels.length) {
            console.log(`已无 ${OLD_MODEL_NAME} 记录，无需清理`);
            await conn.rollback();
            return;
        }
        assert.equal(oldModels.length, 1, `Expected exactly one ${OLD_MODEL_NAME}`);
        const oldId = oldModels[0].id;

        const [bindings] = await conn.execute(
            'SELECT id, channel_id, status FROM model_bindings WHERE logical_model_id = ? FOR UPDATE',
            [oldId]
        );
        const bindingIds = bindings.map(row => row.id);

        const [taskRefs] = await conn.execute(
            `SELECT COUNT(*) AS total FROM async_tasks
             WHERE logical_model_id = ?${bindingIds.length ? ` OR binding_id IN (${bindingIds.map(() => '?').join(',')})` : ''}`,
            [oldId, ...bindingIds]
        );
        assert.equal(Number(taskRefs[0].total), 0, '待删模型/绑定已被 async_tasks 引用，停止清理');

        console.log(`保留 logical_model #${keepId} ${NEW_MODEL_NAME}`);
        console.log(`删除 logical_model #${oldId} ${OLD_MODEL_NAME}`);
        for (const binding of bindings) {
            console.log(`删除 binding #${binding.id} (channel ${binding.channel_id}, status ${binding.status})`);
        }

        if (!dryRun) {
            if (bindingIds.length) {
                await conn.execute(
                    `DELETE FROM model_bindings WHERE id IN (${bindingIds.map(() => '?').join(',')})`,
                    bindingIds
                );
            }
            await conn.execute('DELETE FROM logical_models WHERE id = ?', [oldId]);
        }

        const summary = { database: expectedDb, kept: { id: keepId, name: NEW_MODEL_NAME }, removed: { id: oldId, name: OLD_MODEL_NAME }, removed_binding_ids: bindingIds };
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
