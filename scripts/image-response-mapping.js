// 图片生成响应统一映射：把上游各种形态归一到下游契约
//   { "model": "<逻辑模型名>", "url": "<图片>" }
// 其中 url 有两种形态：
//   - response_format=url 时是 http(s) 链接（上游 data[0].url / image_urls[] / Markdown 图片）；
//   - response_format=b64_json 时是**裸 base64**（上游 data[0].b64_json；上游把图放进
//     data URL 时也拆掉前缀只留 base64）。
// 旧映射只取 data[0].url，而 b64 响应里没有 url 字段，于是下游只剩 { model, created } ——
// 图片整段丢失。这里保证 url 一定有值：有链接给链接，没链接给 base64。
//
// 上游可能出现的形态：
//   1. OpenAI 图像接口：{ created, data: [{ url }] } 或 { created, data: [{ b64_json }] }
//   2. 外层包裹：{ image: { data: [...] } }、{ image: { url } }、{ image_urls: [...] }
//   3. chat/completions 文本结果：choices[0].message.content 里是 Markdown 图片
//      （http 链接或 data URL），或整段裸 base64（字符串 / 文本段数组）。
//
// JSONata 2.x 约束（踩过的坑）：
//   - 表达式里不能写 // 注释（会被当成正则起始）。
//   - 匿名函数体只能是单个表达式；多条语句要用括号包成一个块：function($x) { ($a := ...; ...) }。
//   - and / or 不短路，$length / $match 对 null、数字会抛错，所以每一步先判类型再取值。
//   - 结果里的数组要显式 $append([], $seq)，否则单元素序列会被序列化成对象。

function buildImageResponseMapping(modelName) {
    return `(
  $pick := function($value) { $type($value) = "string" ? $trim($value) : "" };
  $isHttpUrl := function($value) { $boolean($match($value, /^https?:\\/\\/\\S+$/)) };
  $isDataUrl := function($value) { $contains($value, "data:image/") };
  $isRawBase64 := function($value) {
    $length($value) >= 128 and $not($contains($value, " ")) and $boolean($match($value, /^[A-Za-z0-9+\\/]+={0,2}$/))
  };
  $asList := function($value) { $type($value) = "array" ? $value : ($exists($value) ? [$value] : []) };
  $stripDataUrl := function($value) { $trim($substringAfter($value, ",")) };

  $rawContent := $exists(choices) and $count(choices) > 0 ? choices[0].message.content : null;
  $contentText := $type($rawContent) = "string" ? $trim($rawContent)
    : ($type($rawContent) = "array"
      ? $trim($join(
          $filter(
            $map($rawContent, function($part) {
              $type($part) = "string" ? $part
                : ($type($part) = "object" and $type($part.text) = "string" ? $part.text : "")
            }),
            function($text) { $text != "" }
          ),
          " "
        ))
      : "");
  $markdown := $contains($contentText, "](") ? $trim($substringBefore($substringAfter($contentText, "]("), ")")) : "";
  $chatImage := $markdown != "" ? $markdown
    : ($isDataUrl($contentText) or $isHttpUrl($contentText) or $isRawBase64($contentText) ? $contentText : "");

  $candidates := $append(
    $append($asList(data), $asList(image.data)),
    $append(
      $count($asList(image_urls)) > 0 ? $asList(image_urls) : ($type(image.url) = "string" ? [image.url] : []),
      $chatImage != "" ? [$chatImage] : []
    )
  );

  $itemUrl := function($item) { (
    $raw := $type($item) = "string" ? $item : $pick($item.url);
    $isHttpUrl($raw) ? $raw : ""
  ) };

  $itemB64 := function($item) { (
    $rawUrl := $type($item) = "string" ? $item : $pick($item.url);
    $rawB64 := $type($item) = "string" ? "" : $pick($item.b64_json);
    $rawB64 != "" ? ($isDataUrl($rawB64) ? $stripDataUrl($rawB64) : $rawB64)
      : ($isDataUrl($rawUrl) ? $stripDataUrl($rawUrl)
      : ($isRawBase64($rawUrl) ? $rawUrl : ""))
  ) };

  $urls := $filter($map($candidates, $itemUrl), function($value) { $value != "" });
  $b64 := $filter($map($candidates, $itemB64), function($value) { $value != "" });
  $imageUrl := $count($urls) > 0 ? $urls[0] : ($count($b64) > 0 ? $b64[0] : "");

  {
    "model": "${modelName}",
    "url": $imageUrl
  }
)`;
}

module.exports = { buildImageResponseMapping };
