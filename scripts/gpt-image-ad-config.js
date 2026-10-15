// 渠道 gpt-image-ad（https://stars739.top，Bearer）在逻辑模型 gpt-image-2 上的映射。
//
// 上游事实（用该渠道密钥实查 GET /v1/models，只读不计费）：
//   - 模型列表：gpt-image-2 / gpt-image-2.5 / gpt-image-2.5-flare / gpt-image-2.5-sunburst
//   - 文生图 POST /v1/images/generations  JSON：
//     {"model":"gpt-image-2","prompt":"...","quality":"high","n":1,"size":"1792x1024","response_format":"url"}
//   - 图生图 POST /v1/images/edits  multipart/form-data：
//     model / prompt / size / n / quality / response_format + 可重复的 image 文件
//   - 返回（两种入口一致）：{created, background, data:[{generation_id, model, size,
//     url:"data:image/png;base64,...", ...}], output_format, quality, size, usage}
//     即 **图片以 base64 data URL 放在 data[0].url**（不是 http 链接），
//     所以渠道开关 convert_resp_base64_to_url = 1，由网关换成图床 HTTPS 链接再返回下游。
//
// 下游请求形态与其它 gpt-image-2 渠道一致，两种都支持：
//   1) 网关统一模板：{"model":"gpt-image-2","prompt":"...","size":"16:9","quality":"high","n":1,"response_format":"url","images":[...]}
//   2) OpenAI messages 形态：{"model":"gpt-image-2","size":"16:9","messages":[{"role":"user","content":[{"type":"text","text":"..."},{"type":"image_url","image_url":{"url":"..."}}]}]}
//
// 字段规则：
//   上游 model 固定 gpt-image-2（下游逻辑模型名同名，仍按固定值下发，避免下游写错名字）。
//   size           画幅换算 16:9→1792x1024、9:16→1024x1792、1:1→1024x1024、4:3→1536x1152、
//                  3:4→1152x1536；其它值（如 1792x1024 本身）原样透传；缺省 1024x1024。
//   quality        缺省 high（空串 / null 也补 high）。
//   n              缺省 1，原样透传。
//   response_format 字符串 url / b64_json；对象写法与空值都归一成字符串，缺省 url。
//   提示词优先级：prompt > messages[0].content（字符串）> content 里 type=text 的段（空格拼接）> text。
//   参考图来源：顶层 images（字符串 / 数组 / {url} 对象）+ content 里的 image_url.url，合并去空；
//     有参考图 → /v1/images/edits multipart，无参考图 → /v1/images/generations JSON。
//   渠道开关 convert_base64_to_url = 0：multipart 分支的解码由网关的 multipart 构造完成
//     （data URL 直接作为文件内容上传，不必先过图床）。
//
// JSONata 2.2.2 约束：表达式里不能写 // 注释；$map / $filter 的匿名函数体只能是单个表达式；
// and / or 不短路，$length / $map 等对 null、数字会抛错，所以每一步先判类型再取值。

const DEFAULT_API_KEY = 'sk-28542c5bde64b9b73b27e5d83b488ba35a615a44db59393126827505d2d49392';

const UPSTREAM_MODEL = 'gpt-image-2';

const channel = {
    name: 'gpt-image-ad',
    base_url: 'https://stars739.top',
    auth_type: 'bearer',
    api_key: process.env.GPT_IMAGE_AD_API_KEY || DEFAULT_API_KEY,
    // data URL 参考图由网关 multipart 构造直接解码上传，不需要先转图床。
    convert_base64_to_url: 0,
    // 上游把成图以 data:image/png;base64,... 放在 data[0].url，必须换成图床 HTTPS 链接。
    convert_resp_base64_to_url: 1
};

const models = [
    {
        model_name: 'gpt-image-2',
        remark: 'gpt-image-ad（https://stars739.top，Bearer）。上游 model 固定 gpt-image-2；'
            + '文生图 POST /v1/images/generations（JSON：model / prompt / size / quality / n / response_format），'
            + '图生图 POST /v1/images/edits（multipart/form-data，参考图为可重复的 image 文件）。'
            + 'size 支持画幅 16:9→1792x1024、9:16→1024x1792、1:1→1024x1024、4:3→1536x1152、3:4→1152x1536，'
            + '其它值原样透传，缺省 1024x1024；quality 缺省 high；n 缺省 1；response_format 缺省 url。'
            + '下游两种形态都支持：统一模板（prompt + images）与 OpenAI messages（content 里的 text / image_url 段）；'
            + '有参考图走 edits，没有走 generations。'
            + '上游返回 data[0].url 是 data:image/png;base64,... 的 data URL，'
            + '渠道开关 convert_resp_base64_to_url=1 会把它换成图床 HTTPS 链接后返回下游（url 字段）。'
            + '同渠道还有 gpt-image-2.5 / -flare / -sunburst，本次只接 gpt-image-2。'
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
      "model": "${UPSTREAM_MODEL}",
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
    "model": "${UPSTREAM_MODEL}",
    "prompt": $promptText,
    "size": $mappedSize,
    "quality": $q,
    "n": $count,
    "response_format": $rf
  }
)`;

// 上游成图在 data[0].url（data URL）；也兼容只给 data[0].b64_json 的形态，
// 以及 chat 分支的 Markdown 图片。空响应 / 错误体不造链接。
const resp_mapping = `{
  "model": "gpt-image-2",
  "url": $exists(data[0].url) ? data[0].url : ($type(data[0].b64_json) = "string" ? "data:image/png;base64," & data[0].b64_json : $substringBefore($substringAfter(choices[0].message.content, "("), ")"))
}`;

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
    poll_mapping: '{}'
}));

module.exports = {
    DEFAULT_API_KEY,
    UPSTREAM_MODEL,
    channel,
    channels: [channel],
    models,
    bindings,
    req_mapping,
    resp_mapping
};
