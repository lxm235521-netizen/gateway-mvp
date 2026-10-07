// AI 创作（http://116.211.150.21:3000）Seedance 2.0 Fast 渠道配置。
//
// 上游接口文档（站点 /api-guide「API 使用说明」）与实测结论：
//   鉴权：Authorization: Bearer <API_KEY>（缺头/错 key 均返回 401 invalid_token）
//   模型：GET /v1/models -> Seedance 2.0 Fast / Seedance Auto / doubao-video / dola-video
//   提交：POST /v1/videos/generations（wait=false 时 HTTP 202 + task_id）
//   轮询：GET /v1/tasks/{task_id}
//   下载：GET /v1/tasks/{task_id}/download（必须带 Bearer，支持 Range；无鉴权 401，HEAD 404）
//
// 实测的创建响应（HTTP 202）：
//   {"task_id":"task_xxx","status":"pending","model":"Seedance 2.0 Fast",
//    "object":"video.generation","created":1791352315,"data":[],
//    "message":"Task is still running; poll /v1/tasks/task_xxx.","billing":{...}}
// 实测的轮询进行中响应：
//   {"task_id":"task_xxx","status":"pending|processing","progress":"30%","url":"","urls":[],
//    "created_at":"2026-10-07T05:51:55Z","completed_at":"","error":"","error_code":"","model":"Seedance 2.0 Fast"}
// 实测的轮询完成响应：
//   {"status":"completed","progress":"100%","url":"/v1/tasks/task_xxx/download",
//    "urls":["/v1/tasks/task_xxx/download"],"download_url":"/v1/tasks/task_xxx/download",
//    "completed_at":"2026-10-07T05:54:52Z", ...}
//
// 三个需要额外处理的上游事实：
//   1. 完成后的结果地址是**站内相对路径**，不是绝对 URL，必须拼上 base_url 才是可下载地址；
//   2. 结果下载接口需要 Bearer 鉴权且支持 Range，所以绑定开启 proxy_content，
//      由网关 /v1/videos/{task_id}/content 代理取流（同源，网关会带渠道密钥）；
//   3. 上游 created_at / completed_at 是 ISO 8601 字符串，progress 是 "30%" 字符串，
//      都要在 poll_mapping 里归一（Unix 秒、数字进度）。
//
// JSONata 约束（2.2.2）：表达式里不能写 // 注释；$isFinite / $replace / $number 等函数对
// null 与空串会抛错，所以每一步都先做 $type 判断；上游 ISO 时间要先 $contains(x, "T") 再 $toMillis，
// 否则 $toMillis 会对非 ISO 字符串直接抛错。

const DEFAULT_API_KEY = 'sk-JOn3rrjmQUe7Fn04m82StnbV4Pv9UjFExNjMeaTvvCNH3cWn';

const channel = {
    name: 'AI 创作',
    base_url: 'http://116.211.150.21:3000',
    auth_type: 'bearer',
    api_key: process.env.AICREATION_API_KEY || DEFAULT_API_KEY,
    // 只给这个渠道开启「结果地址取流失败时改用站内下载接口」的兜底：
    // 上游的第三方 CDN 直链实测会间歇 403，而 /v1/tasks/{id}/download 一直可用。
    // 其他渠道不开（channels.content_fallback_enabled 默认 0），行为与以前完全一致。
    content_fallback_enabled: 1
};

// 站内下载接口：需要 Bearer、支持 Range，是上游为「已完成任务」提供的稳定取流入口
// （CDN 直链失效时它会重新从供应商取回）。它必然与渠道 base_url 同源，网关代理时会自动
// 带上渠道密钥；跨域的第三方 CDN 直链则不带密钥。地址由 poll_mapping 用 task_id 拼出。

// 上游文档公开的 Seedance 2.0 Fast：seconds 只支持 5 / 10 / 15（统一计费），
// 参考图最多 10 张（image_urls）；不支持参考视频与参考音频，因此不映射 videos / audios。
const models = [
    {
        model_name: 'Seedance 2.0 Fast',
        remark: 'AI 创作 116.211.150.21:3000；上游 model 固定 Seedance 2.0 Fast；prompt 必填（≤5000 字符）；'
            + 'seconds 只支持 5 / 10 / 15（统一计费），未传或非法值回落 5；aspect_ratio 透传（文档示例 16:9 / 9:16 / 1:1）；'
            + '上游无 resolution 字段，下游 resolution 被忽略；images 映射 image_urls（最多 10 张，需公网可访问 URL）。'
            + '不支持参考视频与参考音频。上游状态 pending / processing / completed / failed，'
            + '进度为 "30%" 字符串；完成后 url / urls[] / download_url 是站内相对路径 '
            + '/v1/tasks/{task_id}/download，需要 Bearer 鉴权且支持 Range，因此绑定开启网关代理取流。'
    }
];

// seconds 只支持 5 / 10 / 15：数字或纯数字字符串都接受，其余（缺失、0、-1、小数、非数字、空串）
// 一律回落 5。JSONata 2.2.2 的 $number 对空串/null/非数字字符串会抛错且无法捕获，
// 所以先用 $type + /^[0-9]+$/ 正则确认可用，再调用 $number。
const REQ_MAPPING = `$merge([
  {
    "model": "${models[0].model_name}",
    "prompt": prompt,
    "seconds": $exists(seconds) ? ($type(seconds) = "number" ? (seconds in [5,10,15] ? seconds : 5) : ($type(seconds) = "string" and $count($match(seconds, /^[0-9]+$/)) > 0 ? ($number(seconds) in [5,10,15] ? $number(seconds) : 5) : 5)) : 5,
    "wait": false
  },
  $exists(aspect_ratio) ? { "aspect_ratio": aspect_ratio } : {},
  $exists(images) and $count(images) > 0 ? { "image_urls": images } : {}
])`;

const RESP_MAPPING = `{
  "task_id": $exists(task_id) ? task_id : ($exists(id) ? id : ($exists(data) ? data.task_id : null)),
  "id": $exists(task_id) ? task_id : ($exists(id) ? id : null),
  "status": $exists(status) ? status : "queued",
  "progress": 0,
  "object": $exists(object) ? object : "video",
  "model": $exists(model) ? model : "${models[0].model_name}"
}`;

// 完成时优先返回**站内下载接口**的绝对地址（用 poll 响应的 task_id 拼）：
// 上游对已完成任务既可能给站内相对路径（/v1/tasks/xxx/download），也可能给第三方 CDN 直链
// （例如 https://v3-videoweb.doubao.com/...，带签名、会过期，实测出现过 403 Forbidden）。
// {base_url}/v1/tasks/{task_id}/download 是上游自己的下载入口，需要 Bearer、支持 Range、
// 与渠道同源（网关代理时自动带密钥），CDN 不可用时上游会重新取回，因此它才是稳定的取流地址。
// 上游给的直链保留在 upstream_result_url 里仅供排查，不再作为取流地址。
const POLL_MAPPING = `(
  $rawUrl := $exists(url) and $type(url) = "string" and $length(url) > 0 ? url : "";
  $firstOfUrls := $exists(urls) and $count(urls) > 0 ? $string(urls[0]) : "";
  $firstOfDownloads := $exists(download_urls) and $count(download_urls) > 0 ? $string(download_urls[0]) : "";
  $downloadUrl := $exists(download_url) and $type(download_url) = "string" ? download_url : "";
  $candidate := $rawUrl != "" ? $rawUrl : ($firstOfUrls != "" ? $firstOfUrls : ($firstOfDownloads != "" ? $firstOfDownloads : $downloadUrl));
  $resolvedCandidate := $candidate = "" ? "" : ($substring($candidate, 0, 1) = "/" ? "${channel.base_url}" & $candidate : $candidate);
  $normalizedStatus := $lowercase($string(status));
  $errorMessage := $exists(error) and $type(error) = "string" and $length(error) > 0 ? error : ($exists(display_error_message) and $type(display_error_message) = "string" and $length(display_error_message) > 0 ? display_error_message : null);
  $state := $normalizedStatus = "completed" ? "completed" : (($normalizedStatus = "failed" or $normalizedStatus = "error" or $normalizedStatus = "canceled" or $normalizedStatus = "cancelled" or $normalizedStatus = "rejected" or $errorMessage != null) ? "failed" : (($normalizedStatus = "pending" or $normalizedStatus = "queued" or $normalizedStatus = "not_start" or $normalizedStatus = "unknown") ? "queued" : "processing"));
  $errorText := $errorMessage != null ? $errorMessage : ($state = "failed" ? "上游任务失败: " & $normalizedStatus : null);
  $rawProgress := $replace($string(progress), "%", "");
  $progressValue := $state = "completed" ? 100 : ($type(progress) = "number" ? progress : ($count($match($rawProgress, /^[0-9]+(\.[0-9]+)?$/)) > 0 ? $number($rawProgress) : 0));
  $createdAt := $exists(created_at) and $type(created_at) = "string" and $contains(created_at, "T") ? $floor($toMillis(created_at) / 1000) : ($type(created_at) = "number" ? ($created_at >= 1000000000000 ? $floor(created_at / 1000) : $floor(created_at)) : $floor($millis() / 1000));
  $completedAt := $exists(completed_at) and $type(completed_at) = "string" and $contains(completed_at, "T") ? $floor($toMillis(completed_at) / 1000) : ($state = "completed" ? $createdAt : null);
  $stationUrl := $exists(task_id) and $type(task_id) = "string" and $length(task_id) > 0 ? "${channel.base_url}/v1/tasks/" & task_id & "/download" : "";
  $resolvedUrl := $state = "completed" ? ($stationUrl != "" ? $stationUrl : $resolvedCandidate) : $resolvedCandidate;
  {
    "created_at": $createdAt,
    "model": $exists(model) ? model : "${models[0].model_name}",
    "object": $state = "completed" ? $resolvedUrl : "video.generation",
    "progress": $progressValue,
    "status": $state,
    "video_url": $resolvedUrl,
    "result_url": $resolvedUrl,
    "upstream_result_url": $resolvedCandidate,
    "error": $errorText,
    "error_code": $exists(error_code) and $type(error_code) = "string" and $length(error_code) > 0 ? error_code : null,
    "completed_at": $completedAt
  }
)`;

const bindings = models.map(model => ({
    model_name: model.model_name,
    remark: model.remark,
    route_path: '/v1/videos/generations',
    poll_path: '/v1/tasks/${up_task_id}',
    is_async: 1,
    // 结果地址是站内相对路径且下载需要 Bearer，交给网关代理取流（同源请求会带渠道密钥）。
    proxy_content: 1,
    // 上游建议 60 秒轮询一次；开启节流避免下游高频轮询把上游打爆。
    poll_throttle: 1,
    error_passthrough: 0,
    weight: 1,
    status: 1,
    req_mapping: REQ_MAPPING,
    resp_mapping: RESP_MAPPING,
    poll_mapping: POLL_MAPPING
}));

module.exports = { channel, models, bindings };
