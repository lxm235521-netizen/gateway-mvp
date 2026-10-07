// MCNIO GPT Image 2.5 Sunburst / Flare 渠道配置。
// 上游文档：统一使用 POST https://api.mcnio.com/v1/chat/completions，Bearer 鉴权。
//
// 上游是「固定规格模型名」平台：分辨率和比例都写在 model 名称里，形如
//   gpt-image-2.5-sunburst-{分辨率}-{比例}
//   gpt-image-2.5-flare-{分辨率}-{比例}
// 分辨率为 1k / 2k / 4k，比例为 1x1 / 16x9 / 9x16 / 21x9 / 4x3 / 3x2 / 3x4 / 2x3 / 5x4 / 4x5。
// 上游不接受 duration / aspect_ratio / resolution / size / width / height，
// 也不接受 quality（传了会返回 400，默认质量是 medium）。
//
// 本网关不把 60 个固定规格名全部暴露给下游，只暴露按分辨率分档的两个逻辑模型：
//   gpt-image-2.5-2k  ->  gpt-image-2.5-sunburst-2k-{比例}
//   gpt-image-2.5-4k  ->  gpt-image-2.5-sunburst-4k-{比例}
// 下游只传 model 和 size（比例），网关在 req_mapping 里拼出上游真实模型名。
// 上表以 Sunburst 为默认；需要 Flare 时下游额外传 variant: "flare"，或直接传
// 完整模型名（sunburst-2k-16x9 / gpt-image-2.5-flare-4k-1x1）覆盖档位前缀。
//
// 图生图直接使用消息数组形式：文字放在 messages[0].content 的 text 段，
// 参考图各占一个独立的 image_url 段（1~6 张）。不映射 quality / aspect_ratio /
// size / resolution 这类字段，避免上游 400。
//
// 上游文档未提供真实 Key：渠道先以 api_key = NULL 创建，之后在后台填写，
// 或由下游用上游 Key 作为 Bearer 透传。

const channel = {
    name: 'MCNIO GPT Image',
    base_url: 'https://api.mcnio.com',
    auth_type: 'bearer'
};

// 上游支持的 10 种比例；下游 size 可以写 16:9 也可以写 16x9。
const RATIOS = ['1x1', '16x9', '9x16', '21x9', '4x3', '3x2', '3x4', '2x3', '5x4', '4x5'];

const models = [
    {
        model_name: 'gpt-image-2.5-2k',
        tier: '2k',
        remark: `MCNIO api.mcnio.com；GPT Image 2.5（Sunburst / Flare），2K 档。`
            + `下游只传 model 和 size（比例，例如 16:9 或 16x9），网关拼成上游固定规格名 `
            + `gpt-image-2.5-sunburst-2k-{比例}；需要 Flare 时传 variant: "flare"，`
            + `也可以用 model: gpt-image-2.5-flare-2k-16x9 这种完整名直接覆盖。`
            + `支持比例：${RATIOS.join(' / ')}，缺省 1x1。`
            + `上游不接受 quality（传了 400，默认 medium）、size、aspect_ratio、resolution、duration。`
            + `支持文生图与图生图，图生图 1~6 张参考图（URL / data URL / base64）。`
            + `返回为 choices[0].message.content 里的 Markdown 图片，网关已归一到顶层 url。`
    },
    {
        model_name: 'gpt-image-2.5-4k',
        tier: '4k',
        remark: `MCNIO api.mcnio.com；GPT Image 2.5（Sunburst / Flare），4K 档。`
            + `下游只传 model 和 size（比例，例如 16:9 或 16x9），网关拼成上游固定规格名 `
            + `gpt-image-2.5-sunburst-4k-{比例}；需要 Flare 时传 variant: "flare"，`
            + `也可以用 model: gpt-image-2.5-flare-4k-1x1 这种完整名直接覆盖。`
            + `支持比例：${RATIOS.join(' / ')}，缺省 1x1。`
            + `上游不接受 quality（传了 400，默认 medium）、size、aspect_ratio、resolution、duration。`
            + `支持文生图与图生图，图生图 1~6 张参考图（URL / data URL / base64）。`
            + `4K 上游生成较慢，客户端超时建议 600~900 秒。`
            + `返回为 choices[0].message.content 里的 Markdown 图片，网关已归一到顶层 url。`
    }
];

// 生成指定档位的请求映射。
// - size 支持 "16:9"、"16x9"、"16/9"；缺省 1x1；不在白名单内的比例保留为小写 x 形式交给上游判断。
// - model 若本身已是完整固定规格名（含 sunburst/flare 和 分辨率-比例），按原名里的分辨率和比例重建，
//   即完整名可以覆盖变体名，但档位始终跟随逻辑模型，不会串档。
// - variant 只接受 flare / sunburst，其他值按默认 sunburst 处理。
function buildReqMapping(tier) {
    return `(
      $ratioRaw := $exists(size) and $string(size) != "" ? $lowercase($string(size)) : "1x1";
      $sizeRatio := $replace($replace($ratioRaw, ":", "x"), "/", "x");
      $modelName := $exists(model) ? $lowercase($string(model)) : "";
      $hasVariant := $contains($modelName, "sunburst") or $contains($modelName, "flare");
      $variant := ($exists(variant) and $lowercase($string(variant)) = "flare") or $contains($modelName, "flare") ? "flare" : "sunburst";
      $specRatio := $hasVariant and $match($modelName, /[0-9]+x[0-9]+/) ? $match($modelName, /[0-9]+x[0-9]+/).match : "";
      $ratio := $specRatio != "" ? $specRatio : $sizeRatio;
      $upstreamModel := "gpt-image-2.5-" & $variant & "-${tier}-" & $ratio;
      $rawImages := $exists(images) and $type(images) = "array" ? images : ($exists(images) ? [images] : []);
      $refImages := $filter($rawImages, function($image) {
        ($exists($image.url) and $string($image.url) != "") or ($type($image) != "object" and $string($image) != "" and $string($image) != "null")
      });
      $hasImages := $count($refImages) > 0;
      {
        "_route_path": "/v1/chat/completions",
        "model": $upstreamModel,
        "messages": [{
          "role": "user",
          "content": $hasImages
            ? $append([{ "type": "text", "text": prompt }], $map($refImages, function($image) {
                { "type": "image_url", "image_url": { "url": $exists($image.url) ? $image.url : $image } }
              }))
            : prompt
        }]
      }
    )`;
}

// 上游把生成结果放在 choices[0].message.content，可能是 Markdown 图片、裸 URL 或 data URL。
// 网关归一到顶层 url 与 b64_json；data URL 结果同时保留完整 data URL 与纯 base64 两列。
const resp_mapping = `(
  $content := $exists(choices) and $count(choices) > 0 ? $string(choices[0].message.content) : "";
  $markdownUrl := $substringBefore($substringAfter($content, "]("), ")");
  $isDataUrl := $contains($content, "data:image/");
  $isBareUrl := $contains($content, "http");
  $contentUrl := $isDataUrl ? $content : ($isBareUrl ? $trim($content) : "");
  $url := $exists(data[0].url) ? $string(data[0].url) : ($markdownUrl != "" ? $markdownUrl : $contentUrl);
  $b64 := $exists(data[0].b64_json) ? data[0].b64_json : ($isDataUrl ? $substringAfter($content, ",") : null);
  {
    "model": "gpt-image-2.5",
    "url": $url,
    "b64_json": $b64,
    "data": [{ "url": $url, "b64_json": $b64 }]
  }
)`;

const bindings = models.map(model => ({
    model_name: model.model_name,
    remark: model.remark,
    route_path: '/v1/chat/completions',
    poll_path: null,
    is_async: 0,
    proxy_content: 0,
    req_mapping: buildReqMapping(model.tier),
    resp_mapping
}));

module.exports = { channel, models, bindings, RATIOS, buildReqMapping, resp_mapping };
