const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const jsonata = require('jsonata');
const { buildAuthHeaders } = require('../upstream-auth');
const { bindings, templates } = require('../scripts/vylai-minimax-config');
const plain = value => JSON.parse(JSON.stringify(value));

test('three template mappings preserve supported media, defaults and task states', async () => {
    for (let i=0;i<bindings.length;i++) {
        const b=bindings[i], spec=templates[i], request=jsonata(b.req_mapping);
        const defaults=await request.evaluate({prompt:'test'});
        assert.equal(defaults.template_key,b.model_name);
        assert.deepEqual(plain(defaults.config_values),{mode:'reference',duration:5,aspect:'9:16'});
        for (const seconds of [spec.min,spec.max]) {
            const input={prompt:'test',seconds:String(seconds),resolution:spec.resolutions.at(-1),aspect_ratio:'16:9',images:['https://example.com/i.jpg'],audios:['https://example.com/a.mp3'],videos:['https://example.com/v.mp4']};
            const out=await request.evaluate(input);
            assert.equal(out.config_values.duration,seconds);
            assert.equal(out.config_values.resolution,input.resolution);
            assert.equal(out.config_values.aspect,'16:9');
            assert.deepEqual(plain(out.image_path),input.images);
            assert.equal('video_path' in out,false);
            assert.equal('audio_path' in out,spec.audio);
            if(spec.audio) assert.deepEqual(plain(out.audio_path),input.audios);
        }
        const empty=await request.evaluate({prompt:'test',images:[],audios:[]});
        assert.equal('image_path' in empty,false);
        const response=jsonata(b.resp_mapping);
        assert.equal((await response.evaluate({data:{task_id:'up-1'}})).task_id,'up-1');
        assert.equal((await response.evaluate({code:400,msg:'error'})).task_id,undefined);
        const poll=jsonata(b.poll_mapping);
        for (const [up,down] of Object.entries({pending:'queued',preparing:'processing',running:'processing',completed:'completed',failed:'failed',canceled:'failed'})) {
            const result=await poll.evaluate({data:{status:up,result_oss_url:'https://example.com/out.mp4',error:'failure'}});
            assert.equal(result.status,down);
            if(down==='completed') { assert.equal(result.progress,100); assert.equal(result.video_url,'https://example.com/out.mp4'); }
            if(down==='failed') assert.equal(result.error,'failure');
        }
    }
});

test('auth defaults and invalid auth types', () => {
    assert.deepEqual(buildAuthHeaders('test'),{Authorization:'Bearer test'});
    assert.deepEqual(buildAuthHeaders('test',null),{Authorization:'Bearer test'});
    assert.deepEqual(buildAuthHeaders('test','x-auth-token'),{'X-Auth-Token':'test'});
    assert.deepEqual(buildAuthHeaders(null,'x-auth-token'),{});
    assert.throws(()=>buildAuthHeaders('test','unexpected'));
});

test('HTTP submit and poll use persisted auth, support key precedence and old Bearer tasks', async t => {
    const tasks=new Map(), calls=[], adminWrites=[];
    let currentAuth='x-auth-token', upstreamStatus='running', missingId=false, bindingKey=null;
    let contentRejection=0, rejectAuthenticated=false;
    const db={
        async all(sql,params) {
            if(sql.includes('FROM logical_models lm')) return [{...bindings[0],logical_model_id:1,binding_id:2,channel_id:3,channel_name:'test',base_url:'https://upstream.invalid',channel_auth_type:currentAuth,channel_api_key:'channel-key',api_key:bindingKey}];
            throw Error('Unexpected query');
        },
        async get(sql,params) {
            if(sql.includes('FROM gateway_keys')) return params[0]==='gateway-key' ? {id:1,status:1,quota:100,used_quota:0} : null;
            if(sql.includes('FROM async_tasks')) return tasks.get(params[0]);
            throw Error('Unexpected query');
        },
        async run(sql,params) {
            if(sql.includes('INSERT INTO async_tasks')) {
                assert.equal((sql.match(/\?/g)||[]).length,params.length);
                const names=['gw_task_id','up_task_id','gw_key_id','logical_model_id','binding_id','channel_id','upstream_base_url','poll_path_snapshot','poll_mapping_snapshot','upstream_api_key_snapshot','proxy_content_snapshot','poll_throttle_snapshot','upstream_auth_type_snapshot'];
                tasks.set(params[0],Object.fromEntries(names.map((name,i)=>[name,params[i]])));
            } else if(sql.includes('channels')) adminWrites.push(params);
            return {affectedRows:1,insertId:1};
        }
    };
    const axios={
        async post(url,data,options) {calls.push({url,data,options});return {status:200,data:missingId?{code:400}:{data:{task_id:'up-1'}}};},
        async get(url,options) {
            calls.push({url,options});
            if (options.responseType === 'stream') {
                if (contentRejection && (rejectAuthenticated || (!options.headers.Authorization && !options.headers['X-Auth-Token']))) {
                    return { status: contentRejection, headers: {'content-type':'application/json'}, data: require('node:stream').Readable.from(['unauthorized']) };
                }
                const partial = Boolean(options.headers.Range);
                return {
                    status: partial ? 206 : 200,
                    headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', ...(partial ? { 'content-range': 'bytes 0-3/8' } : {}) },
                    data: require('node:stream').Readable.from([Buffer.from(partial ? 'test' : 'testdata')])
                };
            }
            return {status:200,data:{data:{status:upstreamStatus,result_oss_url:'https://example.com/out.mp4'}}};
        }
    };
    const filename=path.resolve(__dirname,'../server.js'), nativeRequire=createRequire(filename);
    const mod={exports:{}};
    function req(name) {if(name==='./db') return db; if(name==='axios') return axios; if(name==='morgan') return ()=> (_req,_res,next)=>next(); return nativeRequire(name);}
    const context={require:req,module:mod,exports:mod.exports,__dirname:path.dirname(filename),process,console:{log(){},error(){}},Buffer,URL};
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
    const server=mod.exports.app.listen(0,'127.0.0.1');
    await once(server,'listening');
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    const base='http://127.0.0.1:'+server.address().port;
    async function submit(key='gateway-key') {
        const res=await fetch(base+'/v1/videos',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:bindings[0].model_name,prompt:'test',seconds:'5'})});
        return {status:res.status,body:await res.json()};
    }
    const first=await submit(); assert.equal(first.status,200);
    assert.deepEqual(plain(calls.at(-1).options.headers),{'X-Auth-Token':'channel-key'});
    assert.equal(tasks.get(first.body.id).upstream_auth_type_snapshot,'x-auth-token');
    currentAuth='bearer'; // Changing the channel must not change existing task authentication.
    let res=await fetch(base+'/v1/videos/'+first.body.id,{headers:{Authorization:'Bearer gateway-key'}});
    assert.equal((await res.json()).status,'processing');
    assert.deepEqual(plain(calls.at(-1).options.headers),{'X-Auth-Token':'channel-key'});
    assert.equal(calls.at(-1).url,'https://upstream.invalid/openapi/tasks/up-1');
    upstreamStatus='completed';
    res=await fetch(base+'/v1/videos/'+first.body.id+'/content');
    assert.equal(res.status,200);
    assert.equal((await res.json()).url,'https://example.com/out.mp4');
    tasks.get(first.body.id).proxy_content_snapshot=1;
    res=await fetch(base+'/v1/videos/'+first.body.id+'/content');
    assert.equal(res.status,200);
    assert.equal(res.headers.get('content-type'),'video/mp4');
    assert.equal(await res.text(),'testdata');
    assert.equal(calls.at(-1).url,'https://example.com/out.mp4');
    assert.deepEqual(plain(calls.at(-1).options.headers),{});
    res=await fetch(base+'/v1/videos/'+first.body.id+'/content',{headers:{Range:'bytes=0-3','If-Range':'"etag-test"'}});
    assert.equal(res.status,206);
    assert.equal(res.headers.get('content-range'),'bytes 0-3/8');
    assert.equal(await res.text(),'test');
    assert.deepEqual(plain(calls.at(-1).options.headers),{Range:'bytes=0-3','If-Range':'"etag-test"'});
    const contentCalls = () => calls.filter(call => call.options.responseType === 'stream');
    for (const status of [401,403]) {
        contentRejection=status;
        for (const authType of ['x-auth-token','bearer']) {
            tasks.get(first.body.id).upstream_auth_type_snapshot=authType;
            const before=contentCalls().length;
            res=await fetch(base+'/v1/videos/'+first.body.id+'/content',{headers:{Range:'bytes=0-3','If-Range':'"etag-test"'}});
            assert.equal(res.status,206);
            assert.equal(res.headers.get('content-range'),'bytes 0-3/8');
            assert.equal(await res.text(),'test');
            const attempts=contentCalls().slice(before);
            assert.equal(attempts.length,2);
            assert.deepEqual(plain(attempts[0].options.headers),{Range:'bytes=0-3','If-Range':'"etag-test"'});
            assert.deepEqual(plain(attempts[1].options.headers),{Range:'bytes=0-3','If-Range':'"etag-test"',...buildAuthHeaders('channel-key',authType)});
        }
        rejectAuthenticated=true;
        const before=contentCalls().length;
        res=await fetch(base+'/v1/videos/'+first.body.id+'/content');
        assert.equal(res.status,502);
        assert.deepEqual(await res.json(),{error:'Upstream video content request failed',upstream_status:status});
        assert.equal(contentCalls().length-before,2); // Stop after one retry.
        rejectAuthenticated=false;
    }
    // Do not retry other errors, or retry without a saved credential.
    for (const [status,key] of [[404,'channel-key'],[500,'channel-key'],[401,null],[403,null]]) {
        contentRejection=status;
        tasks.get(first.body.id).upstream_api_key_snapshot=key;
        const before=contentCalls().length;
        res=await fetch(base+'/v1/videos/'+first.body.id+'/content');
        assert.equal(res.status,502);
        assert.equal((await res.json()).upstream_status,status);
        assert.equal(contentCalls().length-before,1);
    }
    contentRejection=0;
    tasks.get(first.body.id).upstream_api_key_snapshot='channel-key';
    tasks.get(first.body.id).upstream_auth_type_snapshot='x-auth-token';
    // Same-origin protected content still receives the saved channel credentials.
    tasks.get(first.body.id).upstream_base_url='https://example.com/v1';
    res=await fetch(base+'/v1/videos/'+first.body.id+'/content');
    assert.equal(await res.text(),'testdata');
    assert.deepEqual(plain(calls.at(-1).options.headers),{'X-Auth-Token':'channel-key'});
    tasks.get(first.body.id).upstream_base_url='https://upstream.invalid';
    tasks.get(first.body.id).proxy_content_snapshot=0;
    assert.equal((await fetch(base+'/v1/videos/'+first.body.id)).status,401);
    assert.equal((await fetch(base+'/v1/videos',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(base+'/v1/videos/missing-task/content')).status,404);
    tasks.get(first.body.id).upstream_auth_type_snapshot=null;
    await fetch(base+'/v1/videos/'+first.body.id,{headers:{Authorization:'Bearer gateway-key'}});
    assert.deepEqual(plain(calls.at(-1).options.headers),{Authorization:'Bearer channel-key'});
    await submit(); assert.deepEqual(plain(calls.at(-1).options.headers),{Authorization:'Bearer channel-key'});
    currentAuth='x-auth-token'; bindingKey='binding-key';
    await submit(); assert.deepEqual(plain(calls.at(-1).options.headers),{'X-Auth-Token':'binding-key'});
    await submit('pass-through-key'); assert.deepEqual(plain(calls.at(-1).options.headers),{'X-Auth-Token':'pass-through-key'});
    const before=tasks.size; missingId=true;
    assert.equal((await submit()).status,502); assert.equal(tasks.size,before);
    const token=require('node:crypto').createHash('sha256').update(process.env.ADMIN_PASS||'admin-password').digest('hex');
    const adminHeaders={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    res=await fetch(base+'/admin/channels',{method:'POST',headers:adminHeaders,body:JSON.stringify({name:'test',base_url:'https://example.com',auth_type:'bad'})});
    assert.equal(res.status,400); assert.equal(adminWrites.length,0);
    res=await fetch(base+'/admin/channels/3',{method:'PUT',headers:adminHeaders,body:JSON.stringify({name:'test',base_url:'https://example.com',api_key:'new-key'})});
    assert.equal(res.status,200); assert.equal(adminWrites[0][4],null); // Omission preserves saved auth type.
});

