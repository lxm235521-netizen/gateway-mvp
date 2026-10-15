// 渠道 gpt-image-duolapi（#40，https://api2.duolapi.cn）上 gpt-image-2 绑定的映射。
//
// 上游是 new-api 系网关（响应头 X-New-Api-Version / X-Oneapi-Request-Id）：
//   文生图 POST /v1/images/generations   OpenAI 标准图片接口，JSON，prompt 必填
//   图生图 POST /v1/images/edits         multipart/form-data，参考图字段 image（可重复）
//   鉴权   Authorization: Bearer <渠道密钥>
// 上游模型名固定 gpt-image-fast（下游逻辑模型名 gpt-image-2 不透传）。
//
// 本次改动（2026-10）：文生图分支原来走 /v1/chat/completions + messages，
// 现按需求改为 /v1/images/generations + prompt（OpenAI 标准图片报文）。
// 图生图分支（/v1/images/edits multipart）保持不变。
//
// 下游两种请求形态都兼容：
//   1) 网关统一模板：{"model":"gpt-image-2","prompt":"...","size":"16:9","quality":"high","n":1,"response_format":"url"}
//   2) OpenAI messages 形态：{"model":"gpt-image-2","size":"16:9","messages":[{"role":"user","content":[{"type":"text","text":"..."},{"type":"image_url","image_url":{"url":"..."}}]}]}
// 提示词优先级：prompt > messages[0].content（字符串）> content 里 type=text 的段（空格拼接）> text。
// 参考图来源：顶层 images（字符串 / 数组 / {url} 对象）+ content 里的 image_url.url，合并去空；
//   有参考图 → edits multipart，无参考图 → images/generations JSON。
//
// 字段规则：
//   size           画幅换算 16:9→1792x1024、9:16→1024x1792、1:1→1024x1024、4:3→1536x1152、3:4→1152x1536；
//                  其它值（如 1792x1024）原样透传；缺省 1024x1024。
//   quality        缺省 high（空串 / null 也补 high）。
//   n              缺省 1，原样透传。
//   response_format JSON 分支发字符串（url / b64_json）；缺省 url。
//   渠道开关 convert_base64_to_url = 1：下游 data:image/... 先换图床 HTTPS 链接再提交。
//   渠道开关 convert_resp_base64_to_url = 1：上游只回 data[0].b64_json 时，
//   网关把它换成图床链接再返回下游，下游始终拿到可访问的 http 链接。
//
// 说明：本绑定与「gpt图片生成 Klong」/「688」的映射不是同一份（上游模型名不同），
// scripts/sync-gpt-image-2-mapping.js 默认按「逐字同源」判定，不会覆盖本绑定；
// 只有显式带 --all-bindings 才会被覆盖，改动本文件后需要重新执行本渠道的写入脚本。

// 改动前的版本（走 /v1/chat/completions + messages），登记在这里便于识别历史绑定。
const legacy_req_mappings = [
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
      "model": "gpt-image-fast",
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
    "model": "gpt-image-fast",
    "response_format": { "type": $rf },
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "messages": [{ "role": "user", "content": $promptText }]
  }
)`
];

// 文生图：改为上游 OpenAI 标准图片接口 /v1/images/generations（JSON + prompt）。
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
      "model": "gpt-image-fast",
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
    "model": "gpt-image-fast",
    "prompt": $promptText,
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "response_format": $rf
  }
)`;

// 上游正常返回 data[0].url；只回 data[0].b64_json 时先变成 data URL（渠道开关
// convert_resp_base64_to_url = 1 会把它换成图床链接）；chat 分支的 Markdown 图片仍然兼容。
const legacy_resp_mappings = [
    `{
  "model": "gpt-image-2",
  "url": $exists(data[0].url) ? data[0].url : $substringBefore($substringAfter(choices[0].message.content, "("), ")")
}`
];

const resp_mapping = `{
  "model": "gpt-image-2",
  "url": $exists(data[0].url) ? data[0].url : ($type(data[0].b64_json) = "string" ? "data:image/png;base64," & data[0].b64_json : $substringBefore($substringAfter(choices[0].message.content, "("), ")"))
}`;

const channel = {
    id: 40,
    name: 'gpt-image-duolapi',
    base_url: 'https://api2.duolapi.cn',
    auth_type: 'bearer',
    upstream_model: 'gpt-image-fast',
    text_route_path: '/v1/images/generations',
    image_route_path: '/v1/images/edits',
    logical_model: 'gpt-image-2'
};

module.exports = {
    channel,
    req_mapping,
    resp_mapping,
    legacy_req_mappings,
    legacy_resp_mappings
};
