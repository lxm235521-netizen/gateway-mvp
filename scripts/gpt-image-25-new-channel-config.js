// gpt-image-2.5 新渠道（http://38.127.51.106:4599）配置。
//
// 下游请求方式与渠道「gpt图片生成」（gpt-image-2）完全一致，唯一区别是上游 model 名。
// 逻辑模型复用既有 gpt-image-2.5（与渠道 #15 http://154.9.235.100:3099 是同一逻辑模型的两个渠道）。
//
// 上游实测（2026-10，用本渠道密钥）：
//   GET  /v1/models 列出 gpt-image-2.5（还有 gpt-image-2.5-flare / -sunburst / gpt-image-2 / gpt-image-2-max 等）。
//   POST /v1/images/generations  JSON，response_format 传字符串 "url" -> 200，结果在 data[0].url。
//   POST /v1/images/edits        multipart，image 字段（可重复），response_format 传字符串 -> 200，结果在 data[0].url。
//   POST /v1/chat/completions    不带 response_format -> 200，结果在 choices[0].message.content 的 Markdown 图片，
//                                同时另有顶层 image.data[0].url 与 image_urls[]。
//                                ⚠ 该上游 chat/completions 不接受 response_format：
//                                  传 {"type":"url"} 报 cannot unmarshal object ... response_format of type string；
//                                  传字符串 "url" 又报 cannot unmarshal string ... of type ResponseFormat。
//                                  即该接口的 response_format 字段类型自相矛盾，只能完全不传。
//   另有 5 分钟上游超时：调用不带 quality/response_format 的极简 generations 请求会 504
//   (image generation timed out after 5m0s)，因此请求必须带齐参数。
//
// 因此本渠道不走上游 chat/completions，统一用 images 接口（与既有 #15 绑定同族）：
//   无参考图 -> POST /v1/images/generations
//   有参考图 -> POST /v1/images/edits（multipart，image 可重复）
// 这样 response_format 可以正常传字符串，也不会撞上 chat 接口那个字段类型冲突。
//
// 返回按 CHANNEL_MAPPING_GUIDE.md 第 4 节要求归一到顶层 url（并保留 data[0].url + b64_json，
// 兼容 OpenAI 风格调用方）。两个上游路由都返回 data[0].url；chat 风格的 Markdown 图片也一并兼容。

const BASE_URL = process.env.NEW_IMAGE_BASE_URL || 'http://38.127.51.106:4599';
const API_KEY = process.env.NEW_IMAGE_API_KEY || 'sk-F4LDJcn1b5s5JVB0gTHWS7Z75MIYMOmqIUYgmg6zzWTm9EaN';
// 下游逻辑模型名固定 gpt-image-2.5；上游 model 名单独参数化。
const LOGICAL_MODEL_NAME = 'gpt-image-2.5';
const UPSTREAM_MODEL_NAME = process.env.NEW_IMAGE_UPSTREAM_MODEL || 'gpt-image-2.5';

const { buildImageResponseMapping } = require('./image-response-mapping');

const channels = [
    {
        name: 'gpt-image-2.5 新渠道',
        base_url: BASE_URL,
        auth_type: 'bearer',
        api_key: API_KEY,
        status: 1
    }
];

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
    "_route_path": "/v1/images/generations",
    "model": "${UPSTREAM_MODEL_NAME}",
    "prompt": $promptText,
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "response_format": $rf
  }
)`;

// 按文档第 4 节统一归一（scripts/image-response-mapping.js），响应只有 { model, url }：
//   - response_format=url 时 url 是 data[0].url 里的 http 链接；
//   - response_format=b64_json 时上游**只给 data[0].b64_json（没有 url）**，
//     此时 url 就是裸 base64，否则下游只剩 { model, created }。
const resp_mapping = buildImageResponseMapping(LOGICAL_MODEL_NAME);

const models = [
    {
        model_name: LOGICAL_MODEL_NAME,
        remark: 'gpt-image-2.5 多渠道路由：既有渠道（http://154.9.235.100:3099）与「gpt-image-2.5 新渠道」（' + BASE_URL + '）。'
            + '下游请求方式与 gpt-image-2 的「gpt图片生成」一致：'
            + '统一模板（/v1/images/generations 或 /v1/images/edits，顶层 prompt + images）与 '
            + 'OpenAI messages 风格（/v1/chat/completions，messages[0].content 为字符串或 text+image_url 数组）都支持。'
            + '无参考图走上游 POST /v1/images/generations，有参考图走上游 POST /v1/images/edits（multipart，image 可重复）。'
            + 'size 支持画幅 16:9 / 9:16 / 1:1 / 4:3 / 3:4（换算成 1792x1024 / 1024x1792 / 1024x1024 / 1536x1152 / 1152x1536），'
            + '其他值原样透传，缺省 1024x1024；quality 缺省 high，n 缺省 1；'
            + 'response_format 传字符串或 {type:...} 对象都归一成上游要的字符串，缺省 url。'
            + '返回只有 { model, url }：url 模式给 http 链接；b64_json 模式把裸 base64 放进 url'
            + '（上游 b64 响应里没有 url，旧映射会丢失图片信息）。'
            + '实测注意：该上游 /v1/chat/completions 不接受 response_format（对象与字符串都会 400），'
            + '因此本绑定不走 chat 接口；且上游有 5 分钟超时，请求必须带齐 quality 等参数，否则可能 504。'
    }
];

const bindings = models.map(model => ({
    model_name: model.model_name,
    remark: model.remark,
    route_path: '/v1/images/generations',
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
    LOGICAL_MODEL_NAME,
    UPSTREAM_MODEL_NAME
};
