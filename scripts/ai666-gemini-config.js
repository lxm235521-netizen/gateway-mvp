// 渠道 AI666 Gemini（https://ai666.live）上的逻辑模型 gemini-4-argon。
//
// 上游是 new-api 系网关（响应头 X-New-Api-Version / X-Oneapi-Request-Id），走 **Gemini 原生协议**：
//   非流式 POST /v1beta/models/gemini-4-argon:generateContent
//   流式   POST /v1beta/models/gemini-4-argon:generateContent?alt=sse
//   鉴权   该站实测同时接受 `x-goog-api-key: <Key>` 与 `Authorization: Bearer <Key>`
//          （用 generateContent 空 body 实测：两种头都返回 400「contents is required」而不是 401），
//          因此渠道沿用网关现有的 bearer 鉴权类型，不需要新增头部类型。
//   模型   GET /v1beta/models 实查只有 gemini-3.8-flash 与 gemini-4-argon，本次只接后者。
//
// 下游仍是 OpenAI 协议（POST /v1/chat/completions），网关按下列规则转成 Gemini 报文：
//
//   messages[]                    -> contents[]（role: assistant -> model，其他非 system -> user）
//     content 字符串              -> parts: [{ text }]
//     content 数组里的 text 段    -> parts: [{ text }]
//     content 数组里的 image_url  -> data URL 拆成 parts: [{ inlineData: { mimeType, data } }]；
//                                    http(s) URL 变成 parts: [{ fileData: { fileUri } }]
//     role=system / developer     -> 顶层 systemInstruction.parts[]（多条用空行拼接）
//   temperature                   -> generationConfig.temperature
//   top_p                         -> generationConfig.topP（缺省 0.95）
//   max_tokens / max_completion_tokens -> generationConfig.maxOutputTokens（缺省不下发）
//   n (>1)                        -> generationConfig.candidateCount
//   stop（字符串或数组）           -> generationConfig.stopSequences
//   response_format.type=json_object -> generationConfig.responseMimeType = "application/json"
//   stream=true                   -> 上游改用 ?alt=sse，并置网关内部标记
//                                    `_stream_passthrough: true` + `_stream_transform: "openai"`：
//                                    网关把上游的 Gemini 事件**转换成 OpenAI 风格的 SSE**
//                                    （chat.completion.chunk + choices[].delta + [DONE]）
//   stream 缺省/false             -> 走上游 :generateContent（无 alt=sse），
//                                    响应由 resp_mapping 转成 OpenAI 风格 chat.completion JSON
//
// 注意：
//   - 流式分支输出的是 OpenAI 格式（`data: {"object":"chat.completion.chunk",...}` + `data: [DONE]`），
//     下游可以按标准 OpenAI 流式客户端解析；只想要上游原始 Gemini SSE 时，
//     把 `_stream_transform` 去掉（仅保留 `_stream_passthrough: true`）即可恢复逐字节透传。
//   - 转换规则：Gemini `candidates[].content.parts[].text` 累加成 delta.content；
//     `finishReason` STOP/MAX_TOKENS/SAFETY... 映射成 stop/length/content_filter；
//     最后一个 chunk 带 usage（取自 usageMetadata）；id/created 取上游 responseId/createTime。
//   - 上游报错（400/401/402/429…）时网关先缓冲错误体，再按 error_passthrough=1 原样回给下游
//     （形状是 new-api 的 {"error":{"message":...,"type":"new_api_error","code":...}}）。
//   - tools / functions / tool_calls 未做转换，需要时再补。
//
// JSONata 2.2.2 约束：表达式里不能写 // 注释；$map / $filter 的匿名函数体只能是单个表达式；
// and / or 不短路，$length / $match 等对 null、数字会抛错，所以每一步先判类型再取值。

const DEFAULT_API_KEY = 'sk-0JWh3T5Ibw6EQZp0cLIh0cKr47kVvK9jxk9CIJuo7tbEwxoz';

const UPSTREAM_MODEL = 'gemini-4-argon';

const channel = {
    name: 'AI666 Gemini',
    base_url: 'https://ai666.live',
    auth_type: 'bearer',
    api_key: process.env.AI666_API_KEY || DEFAULT_API_KEY,
    convert_base64_to_url: 0,
    convert_resp_base64_to_url: 0
};

const models = [
    {
        model_name: UPSTREAM_MODEL,
        remark: 'AI666（https://ai666.live，Bearer 与 x-goog-api-key 均可）。Gemini 原生协议：'
            + '非流式 POST /v1beta/models/gemini-4-argon:generateContent，'
            + '流式 POST /v1beta/models/gemini-4-argon:generateContent?alt=sse。'
            + '下游用 OpenAI 协议调用本网关（/v1/chat/completions），映射把 messages 转成 contents、'
            + 'system/developer 转成 systemInstruction，temperature/top_p/max_tokens/n/stop/'
            + 'response_format(json_object) 转成 generationConfig 对应字段（topP 缺省 0.95）。'
            + '参考图：data URL 转 inlineData，http(s) URL 转 fileData.fileUri。'
            + 'stream=true 时上游走 alt=sse，网关把 Gemini 事件转换成 **OpenAI 风格 SSE**'
            + '（chat.completion.chunk + choices[].delta + data: [DONE]，含 usage，可被标准 OpenAI 流式客户端解析）；'
            + '不传 stream 时走非流式，响应映射成 OpenAI 风格 chat.completion JSON（含 usage）。'
            + '上游错误按 error_passthrough 原样返回（new-api 的 {"error":{...}}）。'
    }
];

const ROUTE_STREAM = `/v1beta/models/${UPSTREAM_MODEL}:generateContent?alt=sse`;
const ROUTE_PLAIN = `/v1beta/models/${UPSTREAM_MODEL}:generateContent`;

const req_mapping = `(
  $wantsStream := $type(stream) = "boolean" ? stream : ($type(stream) = "string" ? $lowercase(stream) = "true" : false);
  $msgs := $type(messages) = "array" ? messages : [];
  $isSystem := function($role) { $type($role) = "string" ? ($lowercase($role) = "system" or $lowercase($role) = "developer") : false };
  $textOf := function($content) { $type($content) = "string" ? $content : ($type($content) = "array" ? $join($map($filter($content, function($p) { $type($p) = "object" and $p.type = "text" and $type($p.text) = "string" }), function($p) { $p.text }), "") : "") };
  $systemText := $join($filter($map($filter($msgs, function($m) { $isSystem($m.role) }), function($m) { $trim($textOf($m.content)) }), function($t) { $t != "" }), "\\n\\n");
  $partOf := function($p) {
    $type($p) = "object" ? ($p.type = "text" ? { "text": $type($p.text) = "string" ? $p.text : "" }
      : ($p.type = "image_url" ? ($type($p.image_url.url) = "string" ? ($substring($p.image_url.url, 0, 5) = "data:" ? { "inlineData": { "mimeType": $substringBefore($substringAfter($p.image_url.url, "data:"), ";"), "data": $substringAfter($p.image_url.url, "base64,") } } : { "fileData": { "fileUri": $p.image_url.url } }) : null)
      : null)) : null
  };
  $contents := $count($msgs) > 0 ? [$map($filter($msgs, function($m) { $type($m.role) = "string" and $isSystem($m.role) = false }), function($m) {
    {
      "role": $lowercase($m.role) = "assistant" ? "model" : "user",
      "parts": $type($m.content) = "string" ? [{ "text": $m.content }] : ($type($m.content) = "array" ? [$filter($map($m.content, function($p) { $partOf($p) }), function($x) { $x != null })] : [{ "text": "" }])
    }
  })] : [];
  $toNumber := function($v) { $type($v) = "number" ? $v : ($type($v) = "string" and $count($match($v, /^[0-9]+$/)) > 0 ? $number($v) : null) };
  $maxTokens := $toNumber(max_tokens) != null ? $toNumber(max_tokens) : $toNumber(max_completion_tokens);
  $generationConfig := $merge([
    $maxTokens != null ? { "maxOutputTokens": $maxTokens } : {},
    $type(temperature) = "number" ? { "temperature": temperature } : {},
    { "topP": $type(top_p) = "number" ? top_p : 0.95 },
    ($type(n) = "number" and n > 1) ? { "candidateCount": n } : {},
    $type(stop) = "string" ? { "stopSequences": [stop] } : ($type(stop) = "array" ? { "stopSequences": stop } : {}),
    ($type(response_format) = "object" and response_format.type = "json_object") ? { "responseMimeType": "application/json" } : {}
  ]);
  $merge([
    { "contents": $contents },
    $systemText != "" ? { "systemInstruction": { "parts": [{ "text": $systemText }] } } : {},
    { "generationConfig": $generationConfig },
    { "_route_path": $wantsStream ? "${ROUTE_STREAM}" : "${ROUTE_PLAIN}" },
    $wantsStream ? { "_stream_passthrough": true, "_stream_transform": "openai" } : {}
  ])
)`;

// 非流式响应的归一：Gemini generateContent JSON -> OpenAI 风格 chat.completion。
// 流式分支不会走到这里（网关直接透传上游 SSE）。
const resp_mapping = `(
  $candidate := candidates[0];
  $parts := $type($candidate.content.parts) = "array" ? $candidate.content.parts : [];
  $joined := $join($map($filter($parts, function($p) { $type($p.text) = "string" }), function($p) { $p.text }), "");
  $text := $type($joined) = "string" ? $joined : "";
  $usage := $type(usageMetadata) = "object" ? usageMetadata : {};
  $createdAt := $type(createTime) = "string" and $contains(createTime, "T") ? $floor($toMillis(createTime) / 1000) : $floor($millis() / 1000);
  {
    "id": $type(responseId) = "string" ? responseId : ("chatcmpl-" & $string($floor($millis()))),
    "object": "chat.completion",
    "created": $createdAt,
    "model": "${UPSTREAM_MODEL}",
    "choices": [{
      "index": 0,
      "message": { "role": "assistant", "content": $text },
      "finish_reason": $type($candidate.finishReason) = "string" ? $lowercase($candidate.finishReason) : "stop"
    }],
    "usage": {
      "prompt_tokens": $type($usage.promptTokenCount) = "number" ? $usage.promptTokenCount : 0,
      "completion_tokens": $type($usage.candidatesTokenCount) = "number" ? $usage.candidatesTokenCount : 0,
      "total_tokens": $type($usage.totalTokenCount) = "number" ? $usage.totalTokenCount : 0
    }
  }
)`;

const bindings = models.map(model => ({
    model_name: model.model_name,
    remark: model.remark,
    route_path: ROUTE_PLAIN,
    poll_path: null,
    is_async: 0,
    proxy_content: 0,
    error_passthrough: 1,
    poll_throttle: 0,
    weight: 1,
    status: 1,
    req_mapping,
    resp_mapping,
    poll_mapping: '{}'
}));

module.exports = {
    DEFAULT_API_KEY,
    UPSTREAM_MODEL,
    ROUTE_STREAM,
    ROUTE_PLAIN,
    channel,
    channels: [channel],
    models,
    bindings,
    req_mapping,
    resp_mapping
};
