const MODEL_CAPABILITIES = {
    minSeconds: 3,
    maxSeconds: 30,
    defaultSeconds: 3,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
    maxImages: 10,
    maxVideos: 5,
    maxAudios: 5
};

const channel = {
    name: 'Paipu Video',
    base_url: 'https://api.paipu.net',
    auth_type: 'bearer'
};

const models = [
    { model_name: 'lec-vp-wan-3-0', displayName: 'Wan 3.0' },
    { model_name: 'lec-vp-wan-3-0-prime', displayName: 'Wan 3.0 Prime' }
];

const bindings = models.map(model => ({
    model_name: model.model_name,
    remark: `${model.displayName} (VP); 3-30 秒整数，默认 3 秒；画幅支持 16:9/9:16/1:1，默认 16:9；分辨率支持 720p/1080p，默认 720p；可选 0-10 张图片、0-5 段视频和 0-5 段音频；素材必须是公网 HTTPS URL，单个不超过 20 MiB；原生支持人脸。`,
    route_path: '/v1/videos',
    poll_path: '/v1/videos/${up_task_id}',
    is_async: 1,
    proxy_content: 1,
    error_passthrough: 1,
    poll_throttle: 1,
    weight: 1,
    status: 1,
    req_mapping: `$merge([
      {
        "model": "${model.model_name}",
        "prompt": prompt,
        "duration": $exists(seconds) ? $number(seconds) : ${MODEL_CAPABILITIES.defaultSeconds},
        "aspect_ratio": $exists(aspect_ratio) ? aspect_ratio : "${MODEL_CAPABILITIES.defaultAspectRatio}",
        "resolution": $exists(resolution) ? resolution : "${MODEL_CAPABILITIES.defaultResolution}"
      },
      $count(images) > 0 ? { "images": images } : {},
      $count(videos) > 0 ? { "videos": videos } : {},
      $count(audios) > 0 ? { "audios": audios } : {}
    ])`,
    resp_mapping: `(
      $taskId := $exists(task_id) ? task_id : id;
      {
        "task_id": $taskId,
        "id": $taskId,
        "status": $exists(status) ? status : "queued",
        "progress": $exists(progress) ? progress : 0,
        "object": $exists(object) ? object : "video",
        "model": $exists(model) ? model : "${model.model_name}",
        "created_at": created_at
      }
    )`,
    poll_mapping: `(
      $state := status = "in_progress" ? "processing" : (status = "unknown" ? "queued" : status);
      $resultUrl := $exists(result_url) ? result_url : ($exists(url) ? url : metadata.url);
      {
        "status": $state,
        "phase": phase,
        "progress": $state = "completed" ? 100 : ($exists(progress) ? progress : 0),
        "video_url": $resultUrl,
        "result_url": $resultUrl,
        "object": $state = "completed" ? $resultUrl : "video.generation",
        "model": $exists(model) ? model : "${model.model_name}",
        "seconds": seconds,
        "resolution": $exists(resolution) ? resolution : size,
        "aspect_ratio": aspect_ratio,
        "created_at": created_at,
        "completed_at": completed_at,
        "error": error
      }
    )`
}));

module.exports = { channel, bindings, models, capabilities: MODEL_CAPABILITIES };
