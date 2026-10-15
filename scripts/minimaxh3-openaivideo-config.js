// MINIMAXH3（https://openaivideo.top）「采样」档位渠道配置。
//
// 上游接口文档：本站「文档」面板（保存页 https://openaivideo.top/ 的 /docs 内容），
// 并用该渠道密钥实查了 GET /v1/models（只读，不计费）核对档位上限：
//   鉴权：Authorization: Bearer <Key>（也接受 X-API-Key，或只写 Key）
//   提交：POST /v1/videos/generations（JSON 或 multipart；成功 HTTP 202 + task_id）
//   轮询：GET  /v1/tasks/{task_id}（建议 3~5 秒一次）
//   下载：GET  /v1/tasks/{task_id}/download?index=0
//         GET  /v1/tasks/{task_id}/file/{name}?index=0（同一份文件，需要 Bearer、支持 Range）
//   渠道：请求里的 channel 用 GET /v1/channels 的 name（default = 显示名「低价」）。
//         本渠道不写 channel，走上游默认渠道。
//
// 本次接入的三个档位（逻辑模型名与上游 model id 同名，req_mapping 里固定写死）：
//   MINIMAX-H3-2.5采样-101010  时长 4~30、720p、图 10 / 视频 10 / 音频 10（合计 30）
//   MINIMAX-H3-2.5采样-301010  时长 4~30、720p、图 30 / 视频 10 / 音频 10（合计 50）
//   MINIMAX-H3-2.0采样-933     时长 4~15、720p、图 9  / 视频 3  / 音频 3（合计 15）
// 三个档位都支持 omni_reference（混合素材）；101010 / 301010 另外支持
// first_last_frames 与 multi_frame，933 只支持 multi_frame 与 omni_reference。
//
// 下游统一模板 -> 上游字段：
//   prompt        -> prompt（必填，≤8000 字符）；同时把 @imgN / @vidN / @audN
//                    改写成上游素材名 @image_file_N / @video_file_N / @audio_file_N
//   seconds       -> duration（整数秒，4~该档上限；缺失、越界、小数、非数字一律回落 5）
//   aspect_ratio  -> ratio（该档白名单内原样透传，缺失或白名单外回落 16:9）
//   resolution    -> video_resolution（三个档位都只有 720p，固定下发 720p）
//   images        -> materials[] 里 type=image 的项，name=image_file_N，按 N 编号，超上限截断
//   videos        -> materials[] 里 type=video 的项，name=video_file_N
//   audios        -> materials[] 里 type=audio 的项，name=audio_file_N
//   有素材        -> function_mode=omni_reference
//   没有素材      -> function_mode=first_last_frames（该档不支持时用 omni_reference），
//                    即上游的文生视频路径
//
// 上游不支持直接给「首帧/尾帧」这类角色信息（下游统一模板也没有该字段），
// 因此统一按 omni_reference 混合素材提交；需要在 prompt 里引用某个素材时写
// @image_file_1 / @video_file_1 / @audio_file_1（或上游文档里的 @imgN / @vidN / @audN，
// 网关会自动改写）。素材 URL 必须能被上游服务器访问（公网 http(s) 或图床链接）；
// 渠道已打开「请求 base64 转图床」，下游的 data:image/... 会先换成图床 HTTPS 链接，
// 但视频与音频没有对应的转换，必须是公网 http(s) URL。
//
// 上游返回与轮询：
//   提交响应 {task_id, id?, status:"pending", model, created_at(ISO 8601)}
//   轮询状态 pending / submitted / generating / post_processing / finalizing / success / failed
//     -> 网关统一 queued / processing / completed / failed
//   轮询进度 progress_pct（0~100）+ progress_text
//   完成结果 result_urls[]（预览/播流）与 source_urls[]（高清原片，可能为空数组）
//   失败原因 fail_reason（用户可读文案）
//
// 取流：上游文档明确「轮询体里的 CDN 可能过期或防盗链，落盘请走
// /v1/tasks/{id}/download」，该下载接口需要 Bearer 且支持 Range，因此绑定开启
// proxy_content，video_url 固定拼站内下载地址，由网关 /v1/videos/{id}/content 代理取流
// （渠道同时打开 content_fallback_enabled，代理侧 401/403 时会再回退站内下载接口）。
//
// JSONata 2.2.2 约束（本仓库实测）：表达式里不能写 // 注释；$map / $filter 的匿名函数体
// 只能是单个表达式；`and` 不短路，所以每一步都先判类型再取值（$length / $match /
// $toMillis 对 null、数字、非 ISO 字符串会抛错）。

const DEFAULT_API_KEY = 'jm-2489201b2e7b7280a14e24d5ef25f07175ac631bdef8ca28';

const BASE_URL = 'https://openaivideo.top';

const channel = {
    name: 'MINIMAXH3 视频',
    base_url: BASE_URL,
    auth_type: 'bearer',
    api_key: process.env.MINIMAXH3_API_KEY || DEFAULT_API_KEY,
    // 下游常用 data URL 传参考图，而上游只接受公网可访问的 URL：
    // 提交前把请求体里的 data:image/... 上传图床换成 HTTPS 链接（视频/音频不转换）。
    convert_base64_to_url: 1,
    // 上游结果地址可能过期或防盗链，取流失败（401/403）时回退站内下载接口。
    content_fallback_enabled: 1
};

// 三个档位共用的画幅白名单（来自该密钥 GET /v1/models 的 caps.ratios）。
const RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];

// modes 取自 caps.modes：只有声明了 first_last_frames 的档位才能在「没有素材」时用它走文生视频，
// 否则用 omni_reference（933 就是这种）。
const TIERS = [
    {
        model_name: 'MINIMAX-H3-2.5采样-101010',
        max_duration: 30,
        max_images: 10,
        max_videos: 10,
        max_audios: 10,
        has_first_last_frames: true,
        remark: 'MINIMAXH3 openaivideo.top 档位 101010（图 10 / 视频 10 / 音频 10，合计 30）。'
            + '上游 model 固定 MINIMAX-H3-2.5采样-101010；prompt 必填（≤8000 字符）。'
            + 'seconds 映射 duration：4~30 的整数秒，缺失/越界/小数/非数字回落 5；'
            + 'aspect_ratio 映射 ratio（21:9 / 16:9 / 3:2 / 4:3 / 1:1 / 3:4 / 2:3 / 9:16），缺失或白名单外回落 16:9；'
            + 'resolution 只支持 720p，固定下发 video_resolution=720p。'
            + '图片 / 视频 / 音频分别映射 materials 里的 type=image/video/audio，name 为 '
            + 'image_file_N / video_file_N / audio_file_N（超上限按上限截断，图片最多 10、视频最多 10、音频最多 10）。'
            + '有素材时 function_mode=omni_reference，没有素材时用 first_last_frames 走文生视频；'
            + 'prompt 里的 @imgN / @vidN / @audN 会被改写成 @image_file_N / @video_file_N / @audio_file_N。'
            + '上游状态 pending/submitted/generating/post_processing/finalizing/success/failed，'
            + '进度 progress_pct，结果在 result_urls[]（预览）与 source_urls[]（高清）；'
            + 'video_url 固定拼站内下载地址 /v1/tasks/{task_id}/download?index=0（需要 Bearer、支持 Range），'
            + '因此绑定开启网关代理取流。生成时间很长，下游建议 10~15 秒轮询一次。'
    },
    {
        model_name: 'MINIMAX-H3-2.5采样-301010',
        max_duration: 30,
        max_images: 30,
        max_videos: 10,
        max_audios: 10,
        has_first_last_frames: true,
        remark: 'MINIMAXH3 openaivideo.top 档位 301010（图 30 / 视频 10 / 音频 10，合计 50）。'
            + '与 101010 的唯一区别是参考图上限放宽到 30 张（图片最多 30、视频最多 10、音频最多 10）。'
            + '上游 model 固定 MINIMAX-H3-2.5采样-301010；prompt 必填（≤8000 字符）。'
            + 'seconds 映射 duration：4~30 的整数秒，缺失/越界/小数/非数字回落 5；'
            + 'aspect_ratio 映射 ratio（21:9 / 16:9 / 3:2 / 4:3 / 1:1 / 3:4 / 2:3 / 9:16），缺失或白名单外回落 16:9；'
            + 'resolution 只支持 720p，固定下发 video_resolution=720p。'
            + '图片 / 视频 / 音频分别映射 materials 里的 type=image/video/audio，name 为 '
            + 'image_file_N / video_file_N / audio_file_N；有素材时 function_mode=omni_reference，'
            + '没有素材时用 first_last_frames 走文生视频；prompt 里的 @imgN / @vidN / @audN 会被改写。'
            + '结果在 result_urls[] 与 source_urls[]，video_url 固定拼站内下载地址 '
            + '/v1/tasks/{task_id}/download?index=0（需要 Bearer、支持 Range），绑定开启网关代理取流。'
    },
    {
        model_name: 'MINIMAX-H3-2.0采样-933',
        max_duration: 15,
        max_images: 9,
        max_videos: 3,
        max_audios: 3,
        has_first_last_frames: false,
        remark: 'MINIMAXH3 openaivideo.top 档位 933（图 9 / 视频 3 / 音频 3，合计 15），2.0 采样。'
            + '上游 model 固定 MINIMAX-H3-2.0采样-933；prompt 必填（≤8000 字符）。'
            + 'seconds 映射 duration：4~15 的整数秒，缺失/越界/小数/非数字回落 5；'
            + 'aspect_ratio 映射 ratio（21:9 / 16:9 / 3:2 / 4:3 / 1:1 / 3:4 / 2:3 / 9:16），缺失或白名单外回落 16:9；'
            + 'resolution 只支持 720p，固定下发 video_resolution=720p。'
            + '该档位不支持 first_last_frames（caps.modes 只有 multi_frame / omni_reference），'
            + '因此无论有没有素材都下发 function_mode=omni_reference；没有素材时就是纯提示词出片。'
            + '图片 / 视频 / 音频映射 materials 的 type=image/video/audio，name 为 '
            + 'image_file_N / video_file_N / audio_file_N（图片最多 9、视频最多 3、音频最多 3）；'
            + 'prompt 里的 @imgN / @vidN / @audN 会被改写成 @image_file_N / @video_file_N / @audio_file_N。'
            + '结果在 result_urls[] 与 source_urls[]，video_url 固定拼站内下载地址 '
            + '/v1/tasks/{task_id}/download?index=0（需要 Bearer、支持 Range），绑定开启网关代理取流。'
    }
];

const models = TIERS.map(tier => ({ model_name: tier.model_name, remark: tier.remark }));

// 下游素材可能是字符串 URL、{url} 对象、单个值或数组；统一成「可用素材」数组，
// 并且全程用嵌套三元（JSONata 的 and 不短路，$length 对非字符串会抛错）。
const CLEAN_HELPERS = `
  $asList := function($value) { $type($value) = "array" ? $value : ($type($value) = "string" ? ($length($value) > 0 ? [$value] : []) : ($type($value) = "object" ? ($type($value.url) = "string" ? ($length($value.url) > 0 ? [$value] : []) : []) : [])) };
  $usable := function($item) { $type($item) = "string" ? $length($item) > 0 : ($type($item) = "object" ? ($type($item.url) = "string" ? $length($item.url) > 0 : false) : false) };
  $link := function($item) { $type($item) = "object" ? $item.url : $item };
  $imgsAll := $filter($asList(images), function($item) { $usable($item) });
  $vidsAll := $filter($asList(videos), function($item) { $usable($item) });
  $audsAll := $filter($asList(audios), function($item) { $usable($item) });
`;

const buildReqMapping = tier => `(
${CLEAN_HELPERS}  $imgs := $count($imgsAll) > ${tier.max_images} ? $imgsAll[[0..${tier.max_images - 1}]] : $imgsAll;
  $vids := $count($vidsAll) > ${tier.max_videos} ? $vidsAll[[0..${tier.max_videos - 1}]] : $vidsAll;
  $auds := $count($audsAll) > ${tier.max_audios} ? $audsAll[[0..${tier.max_audios - 1}]] : $audsAll;
  $imgMaterials := $map($imgs, function($item, $i) { { "type": "image", "url": $link($item), "name": "image_file_" & $string($i + 1) } });
  $vidMaterials := $map($vids, function($item, $i) { { "type": "video", "url": $link($item), "name": "video_file_" & $string($i + 1) } });
  $audMaterials := $map($auds, function($item, $i) { { "type": "audio", "url": $link($item), "name": "audio_file_" & $string($i + 1) } });
  $materials := $append($append([$imgMaterials], [$vidMaterials]), [$audMaterials]);
  $secondsNumber := $type(seconds) = "number" ? seconds : ($type(seconds) = "string" ? ($count($match(seconds, /^[0-9]+$/)) > 0 ? $number(seconds) : null) : null);
  $duration := $secondsNumber = null ? 5 : ($floor($secondsNumber) = $secondsNumber and $secondsNumber >= 4 and $secondsNumber <= ${tier.max_duration} ? $secondsNumber : 5);
  $ratio := $type(aspect_ratio) = "string" and (aspect_ratio in ${JSON.stringify(RATIOS)}) ? aspect_ratio : "16:9";
  $promptText := $replace($replace($replace($string(prompt), /@img([0-9]+)/i, "@image_file_$1"), /@vid([0-9]+)/i, "@video_file_$1"), /@aud([0-9]+)/i, "@audio_file_$1");
  $merge([
    {
      "model": "${tier.model_name}",
      "prompt": $promptText,
      "function_mode": $count($materials) > 0 ? "omni_reference" : "${tier.has_first_last_frames ? 'first_last_frames' : 'omni_reference'}",
      "ratio": $ratio,
      "duration": $duration,
      "video_resolution": "720p"
    },
    $count($materials) > 0 ? { "materials": $materials } : {}
  ])
)`;

const buildRespMapping = tier => `{
  "task_id": $exists(task_id) ? task_id : ($exists(id) ? id : ($type(data) = "object" ? data.task_id : null)),
  "id": $exists(task_id) ? task_id : ($exists(id) ? id : null),
  "status": $exists(status) ? status : "queued",
  "progress": 0,
  "object": $exists(object) ? object : "video",
  "model": $exists(model) ? model : "${tier.model_name}"
}`;

// 完成态固定用站内下载地址（{base_url}/v1/tasks/{task_id}/download?index=0）：
// 上游文档明确轮询体里的 CDN 链接可能过期或防盗链，而站内下载接口需要 Bearer、支持 Range，
// 与渠道同源（网关代理时自动带密钥），是最稳的取流入口；上游给的直链只留在
// upstream_result_url 里供排查。没有 task_id 时才退回上游直链。
const buildPollMapping = tier => `(
  $rawStatus := $lowercase($string(status));
  $pct := $type(progress_pct) = "number" ? progress_pct : ($type(progress_pct) = "string" ? ($count($match(progress_pct, /^[0-9]+$/)) > 0 ? $number(progress_pct) : 0) : 0);
  $reason := $type(fail_reason) = "string" ? ($length(fail_reason) > 0 ? fail_reason : null) : null;
  $errorText := $type(error) = "string" ? ($length(error) > 0 ? error : null) : ($type(error) = "object" ? ($type(error.message) = "string" ? ($length(error.message) > 0 ? error.message : null) : null) : null);
  $upstreamError := $type(error_message) = "string" ? ($length(error_message) > 0 ? error_message : null) : null;
  $detail := $reason != null ? $reason : ($errorText != null ? $errorText : $upstreamError);
  $state := $rawStatus = "success" ? "completed" : (($rawStatus = "failed" or $rawStatus = "canceled" or $rawStatus = "cancelled" or $detail != null) ? "failed" : (($rawStatus = "pending" or $rawStatus = "submitted" or $rawStatus = "queued" or $rawStatus = "not_start") ? "queued" : "processing"));
  $source := $exists(source_urls) and $count(source_urls) > 0 ? $string(source_urls[0]) : "";
  $preview := $exists(result_urls) and $count(result_urls) > 0 ? $string(result_urls[0]) : "";
  $direct := $source != "" ? $source : $preview;
  $upTaskId := $type(task_id) = "string" and $length(task_id) > 0 ? task_id : "";
  $station := $upTaskId != "" ? "${BASE_URL}/v1/tasks/" & $upTaskId & "/download?index=0" : "";
  $finalUrl := $state = "completed" ? ($station != "" ? $station : $direct) : "";
  $createdAt := $type(created_at) = "string" ? ($contains(created_at, "T") ? $floor($toMillis(created_at) / 1000) : $floor($millis() / 1000)) : ($type(created_at) = "number" ? ($created_at >= 1000000000000 ? $floor(created_at / 1000) : $floor(created_at)) : $floor($millis() / 1000));
  $completedAt := ($state = "completed" or $state = "failed") ? ($type(completed_at) = "string" ? ($contains(completed_at, "T") ? $floor($toMillis(completed_at) / 1000) : $floor($millis() / 1000)) : $floor($millis() / 1000)) : null;
  {
    "created_at": $createdAt,
    "model": $exists(model) ? model : "${tier.model_name}",
    "object": $state = "completed" ? $finalUrl : "video.generation",
    "progress": $state = "completed" ? 100 : $pct,
    "progress_text": $type(progress_text) = "string" ? progress_text : null,
    "status": $state,
    "video_url": $finalUrl,
    "result_url": $finalUrl,
    "upstream_result_url": $direct,
    "error": $detail != null ? $detail : ($state = "failed" ? "上游任务失败: " & $rawStatus : null),
    "completed_at": $completedAt
  }
)`;

const bindings = TIERS.map(tier => ({
    model_name: tier.model_name,
    remark: tier.remark,
    route_path: '/v1/videos/generations',
    poll_path: '/v1/tasks/${up_task_id}',
    is_async: 1,
    // 站内下载接口需要 Bearer 且支持 Range，交给网关代理取流。
    proxy_content: 1,
    // 生成时间很长（上游约 3.5 小时无结果会退费），开启节流避免下游高频轮询打爆渠道密钥
    // （上游默认 60 次/分钟）。下游建议 10~15 秒轮询一次。
    poll_throttle: 1,
    // 上游提交失败（400 参数无效 / 402 积分不足 / 429 超限）的原文明细直接透传给下游。
    error_passthrough: 1,
    weight: 1,
    status: 1,
    req_mapping: buildReqMapping(tier),
    resp_mapping: buildRespMapping(tier),
    poll_mapping: buildPollMapping(tier)
}));

module.exports = {
    BASE_URL,
    DEFAULT_API_KEY,
    RATIOS,
    TIERS,
    channel,
    channels: [channel],
    models,
    bindings
};
