// 佳速（jiasuapi）Seedance 渠道配置。
// 上游文档：创建视频 POST /v1/video/generations，轮询 GET /v1/videos/tasks/{task_id}。
// 上游请求字段：model / prompt / duration / ratio（别名 aspect_ratio）/ resolution / images / videos / audios。
// 上游提交响应：id / object / model / status / progress / created_at。
// 上游轮询响应：status（queued|in_progress|completed|failed|unknown）/ progress / result_urls[] / completed_at。
//
// 文档未给出真实 Key：渠道先以 api_key = NULL 创建，之后在后台填写，
// 或由下游用上游 Key 作为 Bearer 透传。

const channel = {
    name: '佳速 Seedance',
    base_url: 'https://ai.jiasuapi.com/v1',
    auth_type: 'bearer'
};

// 每个逻辑模型固定映射到同名的上游真实模型名。
// supportsReferenceMedia 为 false 时只映射参考图，忽略下游的 videos / audios。
const models = [
    {
        model_name: 'seedance-2.0-900',
        supportsReferenceMedia: false,
        remark: '佳速 ai.jiasuapi.com；Seedance 2.0。上游 model 固定 seedance-2.0-900；prompt 必填；'
            + 'seconds 映射 duration，未传时用上游按模型 API 参数的默认值并按秒计费；'
            + 'aspect_ratio 映射 ratio，未传时默认 16:9；resolution 未传时默认 720p；'
            + '只支持参考图 images（URL 或 {url,name?}，name 可在 prompt 中用 @名称 引用），不支持参考视频与参考音频。'
            + '上游状态 queued/in_progress/completed/failed/unknown；完成结果在 result_urls[]，为 m.jiasuapi.com 公开 CDN 直链，因此返回直链不代理。'
    },
    {
        model_name: 'seedance-2.0-933',
        supportsReferenceMedia: true,
        remark: '佳速 ai.jiasuapi.com；Seedance 2.0。上游 model 固定 seedance-2.0-933；prompt 必填；'
            + 'seconds 映射 duration，未传时用上游按模型 API 参数的默认值并按秒计费；'
            + 'aspect_ratio 映射 ratio，未传时默认 16:9；resolution 未传时默认 720p；'
            + '支持参考图 images、参考视频 videos、参考音频 audios（均为 URL 或 {url,name?}，name 可在 prompt 中用 @名称 引用）。'
            + '上游状态 queued/in_progress/completed/failed/unknown；完成结果在 result_urls[]，为 m.jiasuapi.com 公开 CDN 直链，因此返回直链不代理。'
    },
    {
        model_name: 'seedance-2.5-101010',
        supportsReferenceMedia: true,
        remark: '佳速 ai.jiasuapi.com；Seedance 2.5。上游 model 固定 seedance-2.5-101010；prompt 必填；'
            + 'seconds 映射 duration，未传时用上游按模型 API 参数的默认值并按秒计费；'
            + 'aspect_ratio 映射 ratio，未传时默认 16:9；resolution 未传时默认 720p；'
            + '支持参考图 images、参考视频 videos、参考音频 audios（均为 URL 或 {url,name?}，name 可在 prompt 中用 @名称 引用）。'
            + '上游状态 queued/in_progress/completed/failed/unknown；完成结果在 result_urls[]，为 m.jiasuapi.com 公开 CDN 直链，因此返回直链不代理。'
    }
];

const bindings = models.map(model => ({
    model_name: model.model_name,
    remark: model.remark,
    route_path: '/video/generations',
    poll_path: '/videos/tasks/${up_task_id}',
    is_async: 1,
    proxy_content: 0,
    req_mapping: `$merge([
      {
        "model": "${model.model_name}",
        "prompt": prompt,
        "resolution": $exists(resolution) ? resolution : "720p",
        "ratio": $exists(aspect_ratio) ? aspect_ratio : "16:9"
      },
      $exists(seconds) ? { "duration": $number(seconds) } : {},
      $exists(images) ? { "images": images } : {}${model.supportsReferenceMedia ? `,
      $exists(videos) ? { "videos": videos } : {},
      $exists(audios) ? { "audios": audios } : {}` : ''}
    ])`,
    resp_mapping: `{
      "task_id": $exists(task_id) ? task_id : id,
      "id": $exists(id) ? id : task_id,
      "status": $exists(status) ? status : "queued",
      "progress": $exists(progress) ? progress : 0,
      "object": $exists(object) ? object : "video",
      "model": $exists(model) ? model : "${model.model_name}",
      "created_at": created_at
    }`,
    poll_mapping: `(
      $status := $lowercase($string(status));
      $resultUrls := $exists(result_urls) ? result_urls : ($exists(data) ? data.result_urls : []);
      $resultUrl := $count($resultUrls) > 0 ? $string($resultUrls[0]) : "";
      $state := $status = "completed" ? "completed" : (($status = "failed" or $status = "error" or $status = "canceled") ? "failed" : (($status = "queued" or $status = "pending" or $status = "unknown") ? "queued" : "processing"));
      {
        "created_at": $exists(created_at) ? created_at : $floor($millis() / 1000),
        "model": $exists(model) ? model : "${model.model_name}",
        "object": $state = "completed" ? $resultUrl : "video.generation",
        "progress": $state = "completed" ? 100 : ($exists(progress) ? progress : 0),
        "status": $state,
        "video_url": $resultUrl,
        "result_url": $resultUrl,
        "error": $exists(error) ? error : ($exists(message) ? message : ($state = "failed" ? $status : null)),
        "completed_at": $exists(completed_at) ? completed_at : null
      }
    )`
}));

module.exports = { channel, models, bindings };
