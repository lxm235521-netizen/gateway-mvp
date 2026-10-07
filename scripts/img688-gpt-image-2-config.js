// 688 图片渠道（https://img.688.qzz.io）的 gpt-image-2 配置。
//
// 上游：https://img.688.qzz.io，Bearer 鉴权，OpenAI 兼容图片服务。
//   GET /v1/models 返回 gpt-image-2 / gpt-image-2.5 / gpt-image-2.5-flare /
//   gpt-image-2.5-sunburst，声明入口 ["image-generation", "openai"]。
//
// 本渠道复用既有逻辑模型 gpt-image-2，与「gpt图片生成」（http://154.9.235.100:3006）
// 和「gpt图片生成 Klong」（https://api.klong.lat）使用**完全相同**的 req_mapping：
//   无参考图 -> 上游 POST /v1/chat/completions（response_format 传 {type:"url"}）
//   有参考图 -> 上游 POST /v1/images/edits（multipart，image 可重复）
// 下游两种形态（网关统一模板 / OpenAI messages 风格）都归一成上面两种上游请求，
// 因此下游不需要为新渠道做任何改动；多个绑定之间按 weight 随机路由。
//
// resp_mapping 在 klong 那版的基础上做了扩展，原因是本渠道的上游会按 base64 返回图片：
//   - 兼容 data[0].url / data[0].b64_json（OpenAI images 风格）
//   - 兼容 choices[0].message.content 里的 Markdown 图片与 data URL
//   - 兼容 choices[0].message.content 直接是裸 base64（或 data URL）
//   - 兼容 image_urls[] / image.url / url 等变体
// base64 结果先原样归一到顶层 url / b64_json，再由网关「返回图片 Base64 转 HTTPS」
// 开关（channels.convert_resp_base64_to_url）上传到图床 files.mmg.lat 换成 http 链接，
// 最终下游拿到的与「gpt图片生成」渠道一致：顶层 url 是 http 链接。
//
// 实测（2026-10，本渠道密钥）：
//   - GET /v1/models 正常返回 200。
//   - 连续调用时上游会返回 HTTP 429「上游返回频率限制，请稍后重试」；此时
//     chat/completions 的 message.content 也可能只是一句「未能生成图片」的错误文本。
//     这类错误不是映射问题，等上游限流恢复后重试即可。
//
// 密钥：脚本写入渠道默认密钥，可用环境变量 IMG688_API_KEY 覆盖。

const BASE_URL = process.env.IMG688_BASE_URL || 'https://img.688.qzz.io';
const DEFAULT_API_KEY = 'sk-ywsrW6Ht3iNGbCH77ajWKN1zuX1jFu1ZlH5EoKtuHm1Pymnt';
const UPSTREAM_MODEL_NAME = 'gpt-image-2';
const LOGICAL_MODEL_NAME = 'gpt-image-2';

const channels = [
    {
        name: 'gpt图片生成 688',
        base_url: BASE_URL,
        auth_type: 'bearer',
        api_key: process.env.IMG688_API_KEY || DEFAULT_API_KEY,
        // 上游按 base64 返回图片，开启响应侧转换后下游拿到的是 http 链接。
        convert_resp_base64_to_url: 1,
        status: 1
    }
];

// 与「gpt图片生成」/ Klong 逐字相同的请求映射：两种下游形态归一到 chat/completions 或 images/edits。
// 注意：JSONata 2.2.2 里不能写 // 注释，and/or 也不短路，说明只能写在模板外面。
const req_mapping = `(
  $ratioMap := {"16:9":"1792x1024", "9:16":"1024x1792", "1:1":"1024x1024", "4:3":"1536x1152", "3:4":"1152x1536"};
  $mappedSize := $lookup($ratioMap, size) ? $lookup($ratioMap, size) : (size ? size : "1024x1024");

  $content := $exists(messages) and $type(messages) = "array" and $count(messages) > 0 ? messages[0].content : null;
  $textFromMessages := $type($content) = "string" ? $trim($content) : "";
  $parts := $type($content) = "array" ? $content : [];
  $textFromParts := $join($filter($map($filter($parts, function($p) { $type($p) = "object" and $p.type = "text" }), function($p) { $trim($string($p.text)) }), function($t) { $t != "" }), " ");
  $imagesFromParts := $map(
    $filter($parts, function($p) {
      $type($p) = "object" and $p.type = "image_url" and $exists($p.image_url.url) and $string($p.image_url.url) != ""
    }),
    function($p) { $string($p.image_url.url) }
  );
  $promptText := $exists(prompt) and $string(prompt) != "" ? $string(prompt)
    : ($textFromMessages != "" ? $textFromMessages
    : ($textFromParts != "" ? $textFromParts
    : ($exists(text) and $string(text) != "" ? $string(text) : "")));

  $rawImages := $append(
    $exists(images) and $type(images) = "array" ? images : ($exists(images) ? [images] : []),
    $imagesFromParts
  );
  $refImages := $map(
    $filter($rawImages, function($i) {
      ($type($i) = "object" and $exists($i.url) and $string($i.url) != "")
        or ($type($i) != "object" and $exists($i) and $string($i) != "" and $string($i) != "null")
    }),
    function($i) { $type($i) = "object" ? $string($i.url) : $string($i) }
  );
  $hasImages := $count($refImages) > 0;

  $rfRaw := $type(response_format) = "string" ? response_format : response_format.type;
  $rf := $type($rfRaw) = "string" ? ($trim($rfRaw) != "" ? $trim($rfRaw) : "url") : "url";
  $qt := $type(quality) = "string" ? $trim(quality) : quality;
  $q := $exists($qt) and $qt != null and $string($qt) != "" ? $qt : "high";
  $count := $exists(n) and n != null ? n : 1;

  $hasImages ? {
    "_route_path": "/v1/images/edits",
    "_request_format": "multipart/form-data",
    "fields": {
      "model": "${UPSTREAM_MODEL_NAME}",
      "prompt": $promptText,
      "size": $mappedSize,
      "quality": $q,
      "n": $count,
      "response_format": $rf
    },
    "files": $append([], $map($refImages, function($img, $index) {
      { "field": "image", "source": $img, "filename": "image-" & $string($index + 1) }
    }))
  } : {
    "_route_path": "/v1/chat/completions",
    "model": "${UPSTREAM_MODEL_NAME}",
    "response_format": { "type": $rf },
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "messages": [{ "role": "user", "content": $promptText }]
  }
)`;

// 归一顺序：OpenAI data[0] -> image 包装 -> image_urls[] -> choices[].message.content。
// content 只在「看起来是图片」时才采用：Markdown 图片、data URL 或整段裸 base64。
// 上游限流/报错时 content 只是一句错误文本，此时 url 必须留空，不能把错误话术当图片链接返回下游。
//
// 这里刻意不用正则：本仓库 JSONata 2.2.2 有两个坑。
//   1. $s ~> /re/ 返回 {match,start,end} 对象，在布尔上下文里恒为假，只有 $match($s, /re/)
//      才返回可用于判断的序列，而 $match 的第二个参数不接受字符串形式的 pattern。
//   2. 正则字面量里出现在字符类内部的 \\/ 会被词法器提前当成结束符，
//      /[^)\\s]/ 这类写法直接报 "No terminating / in regular expression"。
// 因此图片形态判断统一用 $contains / $length / $match($s, /^https?:\\/\\//) 表达。
const resp_mapping = `(
  $content := $exists(choices) and $count(choices) > 0 ? choices[0].message.content : null;
  $contentText := $type($content) = "string" ? $trim($content) : "";
  $markdown := $contentText != "" ? $trim($substringBefore($substringAfter($contentText, "]("), ")")) : "";
  $markdownIsImage := $markdown != "" and ($markdown ~> $substring(0, 7) = "http://" or $markdown ~> $substring(0, 8) = "https://");
  $markdownDataRaw := $contains($markdown, "data:image/") ? $substringAfter($markdown, "data:image/") : "";
  $markdownDataUrl := $markdownDataRaw != "" ? "data:image/" & $markdownDataRaw : "";
  $contentRaw := $type($content) = "array"
    ? $join($filter($map($content, function($p) { $type($p) = "object" ? $string($p.text) : $string($p) }), function($t) { $t != "" }), " ")
    : "";
  $candidate := $markdownIsImage ? $markdown
    : ($markdownDataUrl != "" ? $markdownDataUrl
    : ($contentText != "" ? $contentText : $contentRaw));
  $isDataUrl := $contains($candidate, "data:image/");
  $isRawBase64 := $length($candidate) >= 32 and $not($contains($candidate, " ")) and $match($candidate, /^[A-Za-z0-9+\\/]+={0,2}$/);
  $candidateIsImage := $isDataUrl or $isRawBase64 or ($candidate ~> $substring(0, 7) = "http://" or $candidate ~> $substring(0, 8) = "https://");

  $url := $exists(data[0].url) ? $string(data[0].url)
    : ($exists(data[0].b64_json) ? $string(data[0].b64_json)
    : ($exists(image.data[0].url) ? $string(image.data[0].url)
    : ($exists(image.data[0].b64_json) ? $string(image.data[0].b64_json)
    : ($exists(image.url) ? $string(image.url)
    : ($exists(image_urls) and $count(image_urls) > 0 ? $string(image_urls[0])
    : ($candidateIsImage ? $candidate : ""))))));

  $b64 := $exists(data[0].b64_json) ? $string(data[0].b64_json)
    : ($exists(image.data[0].b64_json) ? $string(image.data[0].b64_json)
    : ($isRawBase64 ? $candidate
    : ($isDataUrl ? $substringAfter($candidate, ",") : null)));

  {
    "model": "${LOGICAL_MODEL_NAME}",
    "url": $url,
    "b64_json": $b64,
    "data": [{ "url": $url, "b64_json": $b64 }]
  }
)`;

// 本渠道发布过的历史请求映射版本。同步脚本 / 复查脚本用它判断某个绑定是否与本渠道同源，
// 避免把别的渠道（例如 YuanAI 4K 专用映射）当成自己的旧版覆盖掉。
// 当前版本与 klong 配置逐字相同，因此这里登记的是更早的历史版本。
const legacy_req_mappings = [];

const models = [
    {
        model_name: LOGICAL_MODEL_NAME,
        remark: 'gpt-image-2 多渠道路由：「gpt图片生成」（http://154.9.235.100:3006）、'
            + '「gpt图片生成 Klong」（https://api.klong.lat）、「gpt图片生成 688」（' + BASE_URL + '）共用同一份请求映射。'
            + '下游两种形态都支持：(1) 统一模板 /v1/images/generations 或 /v1/images/edits，顶层 prompt + images；'
            + '(2) OpenAI 原生 /v1/chat/completions，messages[0].content 为字符串（文生图）或 text+image_url 数组（图生图，从 image_url.url 取参考图）。'
            + '无参考图走上游 POST /v1/chat/completions，有参考图走上游 POST /v1/images/edits（multipart，image 可重复）。'
            + 'size 支持画幅 16:9 / 9:16 / 1:1 / 4:3 / 3:4（换算成 1792x1024 / 1024x1792 / 1024x1024 / 1536x1152 / 1152x1536），其他值原样透传，缺省 1024x1024。'
            + 'quality 缺省 high，n 缺省 1；response_format 传字符串或 {type:...} 对象都会归一成上游要的字符串，缺省 url。'
            + '返回归一到顶层 url（兼容 data[0].url / data[0].b64_json / choices[0].message.content 的 Markdown 图片或 data URL）；'
            + '688 渠道开启了响应侧 base64 转链接，上游返回 base64 时下游拿到的是 files.mmg.lat 的 http 链接。'
    }
];

const bindings = models.map(model => ({
    model_name: model.model_name,
    remark: model.remark,
    route_path: '/v1/chat/completions',
    poll_path: null,
    is_async: 0,
    proxy_content: 0,
    error_passthrough: 1,
    poll_throttle: 0,
    weight: 1,
    status: 1,
    req_mapping,
    resp_mapping,
    poll_mapping: null
}));

module.exports = {
    channels,
    channel: channels[0],
    models,
    bindings,
    req_mapping,
    resp_mapping,
    legacy_req_mappings,
    BASE_URL,
    DEFAULT_API_KEY,
    LOGICAL_MODEL_NAME,
    UPSTREAM_MODEL_NAME,
    CHANNEL_NAME: channels[0].name
};
