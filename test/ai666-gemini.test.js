// 校验渠道 AI666 Gemini（https://ai666.live）在 gemini-4-argon 上的映射：
// 下游 OpenAI 协议 -> 上游 Gemini 原生协议，stream=true 时透传 SSE。
// 只做本地表达式求值，不访问上游、不产生计费请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const cfg = require('../scripts/ai666-gemini-config');

const evaluate = async (expression, data) => JSON.parse(JSON.stringify(await jsonata(expression).evaluate(data)));

test('渠道信息与上游事实一致', () => {
    assert.equal(cfg.channel.name, 'AI666 Gemini');
    assert.equal(cfg.channel.base_url, 'https://ai666.live');
    // 上游 new-api 同时接受 x-goog-api-key 与 Authorization: Bearer（已实测），沿用 bearer。
    assert.equal(cfg.channel.auth_type, 'bearer');
    assert.match(cfg.channel.api_key, /^sk-/);
    assert.equal(cfg.UPSTREAM_MODEL, 'gemini-4-argon');
    assert.equal(cfg.ROUTE_STREAM, '/v1beta/models/gemini-4-argon:generateContent?alt=sse');
    assert.equal(cfg.ROUTE_PLAIN, '/v1beta/models/gemini-4-argon:generateContent');
});

test('绑定是同步 chat 绑定（不走轮询、不代理内容）', () => {
    assert.equal(cfg.bindings.length, 1);
    const binding = cfg.bindings[0];
    assert.equal(binding.model_name, 'gemini-4-argon');
    assert.equal(binding.poll_path, null);
    assert.equal(binding.is_async, 0);
    assert.equal(binding.proxy_content, 0);
    assert.equal(binding.error_passthrough, 1);
    assert.equal(binding.status, 1);
});

test('映射都是合法 jsonata 表达式', async () => {
    for (const expression of [cfg.req_mapping, cfg.resp_mapping]) {
        assert.doesNotThrow(() => jsonata(expression));
    }
    await jsonata(cfg.req_mapping).evaluate({ messages: [{ role: 'user', content: 'x' }] });
    await jsonata(cfg.resp_mapping).evaluate({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
});

test('用户给的流式请求：content 为数组、走 alt=sse 且标记透传', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        model: 'gemini-4-argon',
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
        temperature: 0.7,
        max_tokens: 65536
    });
    assert.deepEqual(mapped, {
        contents: [{ role: 'user', parts: [{ text: '你好' }] }],
        generationConfig: { maxOutputTokens: 65536, temperature: 0.7, topP: 0.95 },
        _route_path: cfg.ROUTE_STREAM,
        _stream_passthrough: true
    });
    // 网关内部标记与路由不能出现在真正发给上游的 body 里（由 server.js 的 meta key 过滤）。
    assert.equal('model' in mapped, false);
    assert.equal('messages' in mapped, false);
    assert.equal('stream' in mapped, false);
});

test('不传 stream：走非流式路由且不带透传标记', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        messages: [{ role: 'user', content: '用一句话解释量子纠缠。' }],
        temperature: 0.7,
        max_tokens: 65536
    });
    assert.equal(mapped._route_path, cfg.ROUTE_PLAIN);
    assert.equal('_stream_passthrough' in mapped, false);
    assert.deepEqual(mapped.generationConfig, { maxOutputTokens: 65536, temperature: 0.7, topP: 0.95 });

    // stream 也可能是字符串 "true"（部分下游写法）。
    assert.equal((await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: 'x' }], stream: 'true' }))._stream_passthrough, true);
    assert.equal('_stream_passthrough' in (await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: 'x' }], stream: false })), false);
});

test('system / developer 进 systemInstruction，assistant 转 model，单条也是数组', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        messages: [
            { role: 'system', content: '你是严谨的助手' },
            { role: 'developer', content: '回答要简短' },
            { role: 'user', content: '问题' },
            { role: 'assistant', content: '回答' }
        ]
    });
    assert.ok(Array.isArray(mapped.contents));
    assert.deepEqual(mapped.contents, [
        { role: 'user', parts: [{ text: '问题' }] },
        { role: 'model', parts: [{ text: '回答' }] }
    ]);
    assert.deepEqual(mapped.systemInstruction, { parts: [{ text: '你是严谨的助手\n\n回答要简短' }] });

    // 单条消息时 contents 仍是数组（JSONata 单元素折标量的坑）。
    const single = await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(Array.isArray(single.contents));
    assert.ok(Array.isArray(single.contents[0].parts));
});

test('多模态：content 数组的 text / image_url 拆成 text / inlineData / fileData', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: '看图' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
                { type: 'input_audio', input_audio: { data: 'x' } }
            ]
        }]
    });
    assert.deepEqual(mapped.contents, [{
        role: 'user',
        parts: [
            { text: '看图' },
            { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
            { fileData: { fileUri: 'https://example.com/a.jpg' } }
        ]
    }]);

    // 只有一个 part 时 parts 仍是数组。
    const onePart = await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: [{ type: 'text', text: 'only' }] }] });
    assert.deepEqual(onePart.contents, [{ role: 'user', parts: [{ text: 'only' }] }]);
});

test('其余 OpenAI 参数映射到 generationConfig，缺省只有 topP 0.95', async () => {
    const mapped = await evaluate(cfg.req_mapping, {
        messages: [{ role: 'user', content: 'x' }],
        temperature: 0.2,
        top_p: 0.5,
        max_completion_tokens: '2048',
        n: 2,
        stop: ['END'],
        response_format: { type: 'json_object' }
    });
    assert.deepEqual(mapped.generationConfig, {
        maxOutputTokens: 2048,
        temperature: 0.2,
        topP: 0.5,
        candidateCount: 2,
        stopSequences: ['END'],
        responseMimeType: 'application/json'
    });
    assert.deepEqual((await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: 'x' }] })).generationConfig, { topP: 0.95 });
    // n=1 不下发 candidateCount，stop 字符串也接受。
    assert.deepEqual(
        (await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: 'x' }], n: 1, stop: 'END' })).generationConfig,
        { topP: 0.95, stopSequences: ['END'] }
    );

    // 异常输入不炸：没有 messages 时 contents 为空数组。
    assert.deepEqual((await evaluate(cfg.req_mapping, {})).contents, []);
    assert.deepEqual((await evaluate(cfg.req_mapping, { messages: 'nope', max_tokens: 'abc', temperature: 'hot' })).contents, []);
});

test('非流式响应归一成 OpenAI 风格 chat.completion', async () => {
    const mapped = await evaluate(cfg.resp_mapping, {
        candidates: [{ content: { parts: [{ text: '量子纠缠是' }, { text: '一种关联。' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20 },
        responseId: 'abc123'
    });
    assert.equal(mapped.object, 'chat.completion');
    assert.equal(mapped.model, 'gemini-4-argon');
    assert.equal(mapped.id, 'abc123');
    assert.deepEqual(mapped.choices, [{ index: 0, message: { role: 'assistant', content: '量子纠缠是一种关联。' }, finish_reason: 'stop' }]);
    assert.deepEqual(mapped.usage, { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 });
    assert.equal(typeof mapped.created, 'number');

    // 空响应也不抛错（成内容为空串、usage 归零）。
    const empty = await evaluate(cfg.resp_mapping, {});
    assert.equal(empty.choices[0].message.content, '');
    assert.deepEqual(empty.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('网关的流式透传开关只认映射里的 _stream_passthrough 标记', () => {
    const { wantsStreamedResponse, isStreamPassthroughPayload } = require('../server').__internal;

    assert.equal(wantsStreamedResponse({ stream: true }), true);
    assert.equal(wantsStreamedResponse({ stream: 'true' }), true);
    assert.equal(wantsStreamedResponse({ stream: 'TRUE' }), true);
    assert.equal(wantsStreamedResponse({ stream: false }), false);
    assert.equal(wantsStreamedResponse({ stream: 'false' }), false);
    assert.equal(wantsStreamedResponse({}), false);
    assert.equal(wantsStreamedResponse(null), false);

    assert.equal(isStreamPassthroughPayload({ _stream_passthrough: true }), true);
    assert.equal(isStreamPassthroughPayload({ _stream_passthrough: false }), false);
    assert.equal(isStreamPassthroughPayload({ contents: [] }), false);
    assert.equal(isStreamPassthroughPayload(null), false);

    // 生产映射的流式请求体一定带标记，非流式一定不带。
    return (async () => {
        const streaming = await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: 'x' }], stream: true });
        const plain = await evaluate(cfg.req_mapping, { messages: [{ role: 'user', content: 'x' }] });
        assert.equal(isStreamPassthroughPayload(streaming), true);
        assert.equal(isStreamPassthroughPayload(plain), false);
    })();
});
