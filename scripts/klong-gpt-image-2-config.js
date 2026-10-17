// klong.lat 的 gpt-image-2 渠道配置。
//
// 上游：https://api.klong.lat，Bearer 鉴权，OpenAI 兼容。
// 上游真实模型名就是 gpt-image-2，GET /v1/models 声明它支持
// openai（chat/completions）、image-generation、image-edits 三种入口。
//
// 本渠道复用既有逻辑模型 gpt-image-2（模型名与上游真实模型名同名），
// 与渠道「gpt图片生成」（http://154.9.235.100:3006）共用同一份 req_mapping /
// resp_mapping，只是 base_url 与密钥不同；下游调用 gpt-image-2 时按 weight 路由。
//
// 下游支持两种请求形态，网关都归一成上游需要的形状：
//
//   1) 网关统一模板（顶层 prompt / images）
//      - 无参考图 -> 上游 POST /v1/images/generations
//      - 有参考图 -> 上游 POST /v1/images/edits（multipart，image 可重复）
//
//   2) OpenAI 原生 /v1/chat/completions 风格（下游插件常用）
//      - messages[0].content 是字符串 -> 文生图
//      - messages[0].content 是数组（text + image_url 段）-> 图生图，
//        参考图从 image_url.url 段提取
//
// 实测确认（2026-10）：
// - 上游 POST /v1/images/generations、/v1/chat/completions、/v1/images/edits 都返回
//   data[0].url；chat/completions 还会返回 choices[0].message.content 里的 Markdown 图片。
//   但 chat 接口不保证按 response_format 给 http 链接（可能内联 data URL base64），
//   文生图因此改发 /v1/images/generations，与下游 curl 直连上游拿到链接的行为一致。
// - 上游 Go 网关把 response_format.type 声明成 string：传 {"type":"url"} 会 400
//   (json: cannot unmarshal object into Go struct field ResponseFormat.response_format.type of type string)。
//   因此三个上游入口（chat/completions、images/generations、images/edits）的 response_format
//   都必须发字符串 "url"；下游无论传字符串还是 {"type":"url"} 对象，网关都归一成字符串。
// - 上游 Images edits 要求 prompt 非空，参考图必须是真实可解码的图片（image_parse_error）。
//
// 密钥：脚本写入渠道默认密钥，可用环境变量 KLONG_API_KEY 覆盖。
// 下游若用上游 Key 作为 Bearer 透传，会按网关既有优先级覆盖该渠道密钥。

const DEFAULT_API_KEY = 'sk-cpqOEDajlnxxSIo79CRsG7IOOyiUhJuDYxhcygPT3bkFfC0Z';

const channels = [
    {
        name: 'gpt图片生成 Klong',
        base_url: 'https://api.klong.lat',
        auth_type: 'bearer',
        api_key: process.env.KLONG_API_KEY || DEFAULT_API_KEY,
        status: 1
    }
];

// 同时兼容「统一模板」与「OpenAI messages 风格」，并统一 response_format 为字符串。
// 注意：表达式里不能写 // 注释（JSONata 会把 / 当正则起始符，抛
// "Empty regular expressions are not allowed"），说明只能写在模板外面。
// $exists 对 null 也返回 true，所以 quality / response_format 的缺省判断必须显式判 null，
// 否则下游传 null 会把 null 原样发给上游。
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
      "model": "gpt-image-2",
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
    "model": "gpt-image-2",
    "prompt": $promptText,
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "response_format": $rf
  }
)`;

// 文生图分支 2026-10 由上游 /v1/chat/completions 改为 /v1/images/generations：
//   上游 chat 接口返回的是 choices[0].message.content 里的 Markdown 图片（可能是内联的
//   data URL base64），而 images/generations 按 response_format="url" 返回 data[0].url 的
//   http 链接。下游要的是链接，所以就发下游实际期望的那个接口。
//   图生图分支仍走 /v1/images/edits multipart（上游 edits 接口不接受 messages）。

// 返回统一由 scripts/image-response-mapping.js 归一，响应只有 { model, url }：
//   - 上游按 response_format="url" 返回时 url 是 http 链接
//     （data[0].url / image_urls / Markdown 图片都兼容）；
//   - 上游按 response_format="b64_json" 返回时**只有 data[0].b64_json、没有 url**，
//     此时 url 就是裸 base64（旧版映射只取 data[0].url，响应会只剩 { model, created }）。
const { buildImageResponseMapping } = require('./image-response-mapping');

const resp_mapping = buildImageResponseMapping('gpt-image-2');

// 本渠道历次发布过的 req_mapping。同步脚本用它判断某个绑定是否是「同源旧版」，
// 从而只更新本渠道自己的绑定，不误伤其它渠道（例如 YuanAI 的 4K 专用映射）。
// 每次改动 req_mapping 后，把被替换掉的版本记到这里。
const legacy_req_mappings = [
    // v1：只认顶层 prompt/images，不支持 messages 风格；response_format 会套两层对象。
    `(
  $ratioMap := {"16:9":"1792x1024", "9:16":"1024x1792", "1:1":"1024x1024", "4:3":"1536x1152", "3:4":"1152x1536"};
  $mappedSize := $lookup($ratioMap, size) ? $lookup($ratioMap, size) : (size ? size : "1024x1024");
  $hasImages := $exists(images) and $count(images) > 0;
  $hasImages ? {
    "_route_path": "/v1/images/edits",
    "_request_format": "multipart/form-data",
    "model": "gpt-image-2",
    "prompt": prompt,
    "size": $mappedSize,
    "quality": quality ? quality : "high",
    "n": n ? n : 1,
    "response_format": response_format ? response_format : "url",
    "_file_fields": ["image"],
    "image": images
  } : {
    "_route_path": "/v1/chat/completions",
    "model": "gpt-image-2",
    "response_format": {"type": response_format ? response_format : "url"},
    "size": $mappedSize,
    "quality": quality ? quality : "high",
    "n": n ? n : 1,
    "messages": [{"role": "user", "content": prompt}]
  }
)`,
    // v2：支持 messages 风格，但 quality 传 null/空串时不会补 high，response_format 也可能留空。
    `(
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

  $rf := $exists(response_format)
    ? ($type(response_format) = "string" ? response_format : (response_format.type ? response_format.type : "url"))
    : "url";
  $q := $exists(quality) and $string(quality) != "" ? quality : "high";
  $count := $exists(n) ? n : 1;

  $hasImages ? {
    "_route_path": "/v1/images/edits",
    "_request_format": "multipart/form-data",
    "fields": {
      "model": "gpt-image-2",
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
    "model": "gpt-image-2",
    "response_format": { "type": $rf },
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "messages": [{ "role": "user", "content": $promptText }]
  }
)`,
    // v4：chat/completions 分支曾发 {"type": ...} 对象，上游 Go 网关要求字符串，已修正。
    `(
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
      "model": "gpt-image-2",
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
    "model": "gpt-image-2",
    "response_format": { "type": $rf },
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "messages": [{ "role": "user", "content": $promptText }]
  }
)`,
    // v5：文生图曾走上游 /v1/chat/completions（chat 接口可能回内联 base64），已改为 /v1/images/generations。
    `(
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
      "model": "gpt-image-2",
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
    "model": "gpt-image-2",
    "response_format": $rf,
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "messages": [{ "role": "user", "content": $promptText }]
  }
)`
];

const models = [
    {
        model_name: 'gpt-image-2',
        remark: 'gpt-image-2 由多渠道路由：「gpt图片生成」（http://154.44.9.233:8010）与「gpt图片生成 Klong」（https://api.klong.lat）共用同一份映射。'
            + '下游两种形态都支持：(1) 统一模板 /v1/images/generations 或 /v1/images/edits，顶层 prompt + images；'
            + '(2) OpenAI 原生 /v1/chat/completions，messages[0].content 为字符串（文生图）或 text+image_url 数组（图生图，从 image_url.url 取参考图）。'
            + '无参考图走上游 POST /v1/images/generations（JSON：prompt/size/quality/n/response_format），有参考图走上游 POST /v1/images/edits（multipart，image 可重复）。'
            + 'size 支持画幅 16:9 / 9:16 / 1:1 / 4:3 / 3:4（换算成 1792x1024 / 1024x1792 / 1024x1024 / 1536x1152 / 1152x1536），其他值原样透传，缺省 1024x1024。'
            + 'quality 缺省 high，n 缺省 1；response_format 传字符串或 {type:...} 对象都会归一成上游要的字符串，缺省 url。'
            + '返回只有 { model, url }：url 模式给 http 链接，b64_json 模式把裸 base64 放进 url'
            + '（上游 b64 响应里没有 url 字段，旧映射会丢图）。'
            + '注意：网关只解析 JSON 请求体，不接受下游直接发 multipart；参考图用 data URL 或 HTTPS URL。'
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
    DEFAULT_API_KEY
};
