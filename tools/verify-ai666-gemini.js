// 端到端校验 AI666 Gemini 渠道：用本机 mock 上游（不消耗上游额度）验证
//  1) OpenAI 协议 -> Gemini 协议 的请求转换（contents / systemInstruction / generationConfig）
//  2) stream=true 时把上游 SSE **原样透传**给下游（含 content-type）
//  3) 非流式时把 Gemini JSON 归一成 OpenAI 风格 chat.completion
//  4) 上游报错时按 error_passthrough 原样返回状态码与错误体
//
// 做法：临时建一个指向 mock 的渠道 + 逻辑模型 + 绑定，**映射逐字取自生产绑定**
// （渠道 AI666 Gemini 上 gemini-4-argon 的 req_mapping / resp_mapping），跑完无条件删除临时记录，
// 生产渠道与绑定全程不变。
//
// 用法（需要能连网关与数据库）：
//   $env:DB_HOST='154.36.173.77'; $env:DB_PORT='3310'; $env:DB_NAME='gateway'
//   $env:DB_USER='gateway'; $env:DB_PASSWORD='gateway-password'
//   node tools/verify-ai666-gemini.js [网关地址] [网关密钥] [mock 端口]
// 默认：http://127.0.0.1:3009、sk-test-key-123、4621
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const db = require('../db');

const GATEWAY_URL = (process.argv[2] || 'http://127.0.0.1:3009').replace(/\/+$/, '');
const GATEWAY_KEY = process.argv[3] || 'sk-test-key-123';
const MOCK_PORT = Number(process.argv[4] || 4621);

const PROD_CHANNEL_NAME = 'AI666 Gemini';
const PROD_MODEL_NAME = 'gemini-4-argon';
const TEMP_CHANNEL_NAME = 'ZZ 临时校验 ai666';
const TEMP_MODEL_NAME = 'zz-ai666-verify';
const TEMP_API_KEY = 'sk-zz-ai666-verify';

const SSE_BODY = 'data: {"candidates":[{"content":{"parts":[{"text":"你好"}],"role":"model"},"finishReason":"STOP"}]}\n\n';
const GEMINI_JSON = {
    candidates: [{ content: { parts: [{ text: '量子纠缠是' }, { text: '一种关联。' }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20 },
    responseId: 'mock-response-id'
};

const results = [];
function check(name, condition, detail) {
    results.push({ name, ok: Boolean(condition), detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : '  -> ' + JSON.stringify(detail)}`);
}

// ---- mock 上游：按 mode 返回 SSE / JSON / 错误体，并记录收到的请求 ----
let mode = 'sse';
const received = [];
const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try { body = JSON.parse(raw); } catch (error) { /* 保留原文 */ }
        received.push({ method: req.method, url: req.url, headers: req.headers, body, raw });

        if (mode === 'error') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'mock rate limit', type: 'new_api_error', code: 'rate_limit' } }));
        }
        if (mode === 'sse') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(SSE_BODY);
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(GEMINI_JSON));
    });
});

async function createTempBinding() {
    const prod = await db.get(
        `SELECT b.req_mapping, b.resp_mapping
         FROM model_bindings b
         JOIN logical_models lm ON lm.id = b.logical_model_id
         JOIN channels c ON c.id = b.channel_id
         WHERE c.name = ? AND lm.model_name = ?
         ORDER BY b.status DESC, b.id LIMIT 1`,
        [PROD_CHANNEL_NAME, PROD_MODEL_NAME]
    );
    assert.ok(prod, `生产绑定不存在：${PROD_CHANNEL_NAME} / ${PROD_MODEL_NAME}`);

    const channel = await db.run(
        'INSERT INTO channels (name,base_url,auth_type,api_key,status) VALUES (?,?,?,?,1)',
        [TEMP_CHANNEL_NAME, `http://host.docker.internal:${MOCK_PORT}`, 'bearer', TEMP_API_KEY]
    );
    const model = await db.run('INSERT INTO logical_models (model_name,status) VALUES (?,1)', [TEMP_MODEL_NAME]);
    const binding = await db.run(
        `INSERT INTO model_bindings
            (logical_model_id,channel_id,route_path,poll_path,api_key,is_async,proxy_content,error_passthrough,poll_throttle,req_mapping,resp_mapping,poll_mapping,weight,status)
         VALUES (?,?,?,NULL,NULL,0,0,1,0,?,?,?,1,1)`,
        [model.insertId, channel.insertId, '/v1beta/models/gemini-4-argon:generateContent', prod.req_mapping, prod.resp_mapping, '{}']
    );
    return { channelId: channel.insertId, modelId: model.insertId, bindingId: binding.insertId };
}

async function cleanup(temp) {
    if (!temp) return;
    await db.run('DELETE FROM model_bindings WHERE id = ?', [temp.bindingId]);
    await db.run('DELETE FROM logical_models WHERE id = ?', [temp.modelId]);
    await db.run('DELETE FROM channels WHERE id = ?', [temp.channelId]);
}

async function main() {
    await new Promise(resolve => server.listen(MOCK_PORT, '0.0.0.0', resolve));
    console.log(`mock 上游已启动：http://0.0.0.0:${MOCK_PORT}（容器经 host.docker.internal 访问）`);

    let temp = null;
    try {
        temp = await createTempBinding();
        console.log(`临时渠道 #${temp.channelId} / 逻辑模型 #${temp.modelId} / 绑定 #${temp.bindingId}（映射取自生产绑定）`);

        const call = (payload, responseType) => axios.post(`${GATEWAY_URL}/v1/chat/completions`, payload, {
            headers: { Authorization: `Bearer ${GATEWAY_KEY}`, 'Content-Type': 'application/json' },
            timeout: 60000,
            responseType: responseType || 'json',
            validateStatus: () => true
        });

        // ---- 1. 流式：OpenAI 请求 -> Gemini 请求 + SSE 原样透传 ----
        received.length = 0;
        mode = 'sse';
        const streamed = await call({
            model: TEMP_MODEL_NAME,
            messages: [{ role: 'user', content: '你好' }],
            stream: true,
            temperature: 0.7,
            max_tokens: 65536
        }, 'text');

        check('流式：网关返回 200', streamed.status === 200, streamed.status);
        check('流式：content-type 是 text/event-stream', String(streamed.headers['content-type']).includes('text/event-stream'), streamed.headers['content-type']);
        check('流式：SSE 逐字节透传（未做响应映射）', streamed.data === SSE_BODY, streamed.data);

        const got = received[0];
        check('流式：上游路径带 alt=sse', got && got.url === '/v1beta/models/gemini-4-argon:generateContent?alt=sse', got && got.url);
        check('流式：鉴权头是渠道 Bearer 密钥', got && got.headers.authorization === `Bearer ${TEMP_API_KEY}`, got && got.headers.authorization);
        check('流式：请求体是 Gemini 协议', got && JSON.stringify(got.body) === JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: '你好' }] }],
            generationConfig: { maxOutputTokens: 65536, temperature: 0.7, topP: 0.95 }
        }), got && got.body);
        check('流式：网关内部字段（_route_path / _stream_passthrough）没有发给上游',
            got && !('_route_path' in got.body) && !('_stream_passthrough' in got.body), got && got.body);
        check('流式：OpenAI 字段没有泄漏到上游', got && !('messages' in got.body) && !('stream' in got.body) && !('model' in got.body), got && got.body);

        // ---- 2. 非流式：Gemini JSON -> OpenAI 风格 chat.completion ----
        received.length = 0;
        mode = 'json';
        const plain = await call({
            model: TEMP_MODEL_NAME,
            messages: [{ role: 'system', content: '简洁回答' }, { role: 'user', content: '用一句话解释量子纠缠。' }],
            temperature: 0.7,
            max_tokens: 65536
        });
        check('非流式：网关返回 200 + JSON', plain.status === 200 && plain.data && plain.data.object === 'chat.completion', plain.data);
        check('非流式：内容归一成 choices[0].message.content', plain.data.choices && plain.data.choices[0].message.content === '量子纠缠是一种关联。', plain.data.choices);
        check('非流式：usage 映射', plain.data.usage && plain.data.usage.total_tokens === 20, plain.data.usage);
        const plainReq = received[0];
        check('非流式：上游路径不带 alt=sse', plainReq && plainReq.url === '/v1beta/models/gemini-4-argon:generateContent', plainReq && plainReq.url);
        check('非流式：system 进 systemInstruction、user 进 contents', plainReq && JSON.stringify(plainReq.body) === JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: '用一句话解释量子纠缠。' }] }],
            systemInstruction: { parts: [{ text: '简洁回答' }] },
            generationConfig: { maxOutputTokens: 65536, temperature: 0.7, topP: 0.95 }
        }), plainReq && plainReq.body);

        // ---- 3. 上游报错：状态码与错误体原样透传 ----
        received.length = 0;
        mode = 'error';
        const failed = await call({ model: TEMP_MODEL_NAME, messages: [{ role: 'user', content: 'x' }], stream: true });
        check('上游 429：状态码透传', failed.status === 429, failed.status);
        check('上游 429：new-api 错误体透传', failed.data && failed.data.error && failed.data.error.code === 'rate_limit', failed.data);

        const failures = results.filter(item => !item.ok);
        console.log(`\n${results.length - failures.length}/${results.length} 项通过`);
        if (failures.length) {
            process.exitCode = 1;
        }
    } finally {
        await cleanup(temp);
        console.log(temp ? `已删除临时记录（渠道 #${temp.channelId} / 逻辑模型 #${temp.modelId} / 绑定 #${temp.bindingId}）` : '未创建临时记录');
        server.close();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(() => db.pool.end());
