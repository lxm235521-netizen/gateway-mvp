// Run inside the gateway container to use its actual database environment.
const assert = require('node:assert/strict');
const { channel, bindings } = require('./vylai-minimax-config');
const db = require('../db');
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
        const [channels] = await conn.execute('SELECT id,name,base_url,auth_type FROM channels WHERE name=? OR base_url=? FOR UPDATE', [channel.name,channel.base_url]);
        assert.ok(channels.length <= 1, 'Multiple matching channels; inspect before changing');
        let channelId;
        if (channels.length) {
            assert.equal(channels[0].base_url,channel.base_url);
            assert.equal(channels[0].auth_type,channel.auth_type);
            channelId = channels[0].id;
        } else {
            const [created] = await conn.execute('INSERT INTO channels (name,base_url,auth_type,api_key,status) VALUES (?,?,?,NULL,1)',[channel.name,channel.base_url,channel.auth_type]);
            channelId=created.insertId;
        }
        const saved=[];
        for (const item of bindings) {
            let [models] = await conn.execute('SELECT id FROM logical_models WHERE model_name=?',[item.model_name]);
            let modelId = models[0]?.id;
            if (!modelId) {
                const [created] = await conn.execute('INSERT INTO logical_models (model_name,status,remark) VALUES (?,1,?)',[item.model_name,item.remark]);
                modelId=created.insertId;
            }
            const [existing] = await conn.execute('SELECT id,req_mapping,resp_mapping,poll_mapping,route_path,poll_path FROM model_bindings WHERE logical_model_id=? AND channel_id=?',[modelId,channelId]);
            assert.ok(existing.length<=1,'Duplicate binding');
            let bindingId=existing[0]?.id;
            if (bindingId) {
                for (const key of ['req_mapping','resp_mapping','poll_mapping','route_path','poll_path']) assert.equal(existing[0][key],item[key],'Existing binding differs: '+key);
            } else {
                const [created] = await conn.execute('INSERT INTO model_bindings (logical_model_id,channel_id,route_path,poll_path,api_key,is_async,proxy_content,error_passthrough,poll_throttle,req_mapping,resp_mapping,poll_mapping,weight,status) VALUES (?,?,?,?,NULL,1,0,1,0,?,?,?,1,1)',[modelId,channelId,item.route_path,item.poll_path,item.req_mapping,item.resp_mapping,item.poll_mapping]);
                bindingId=created.insertId;
            }
            saved.push({model:item.model_name,model_id:modelId,binding_id:bindingId});
        }
        await conn.commit();
        console.log(JSON.stringify({database:expectedDb,host:expectedHost,channel_id:channelId,channel:channel.name,models:saved}));
    } catch(e) {await conn.rollback(); throw e;}
    finally {conn.release();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.pool.end());
