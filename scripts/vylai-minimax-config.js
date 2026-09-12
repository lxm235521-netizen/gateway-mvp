const templates = [
    { name: '75api-minimax-h3-audio-20260911', audio: true, min: 5, max: 15, resolutions: ['480p', '768p'] },
    { name: '75api-minimax-h3-fast-20260911', audio: false, min: 1, max: 15, resolutions: ['480p', '768p'] },
    { name: '75api-minimax-h3-fast-1080p-20260911', audio: false, min: 1, max: 10, resolutions: ['480p', '768p', '1080p'] }
];
const channel = { name: 'Vylai MiniMax H3', base_url: 'https://queueapi.vylai.com', auth_type: 'x-auth-token' };
const bindings = templates.map(template => ({
    model_name: template.name,
    remark: `Vylai MiniMax H3；prompt 必填；seconds 为 ${template.min}–${template.max} 的整数，默认 5；resolution 支持 ${template.resolutions.join('/')}，未传时使用上游模板默认值；aspect_ratio 默认 9:16，支持 1:1、2:3、3:2、3:4、4:3、9:16、16:9、21:9。${template.audio ? '可选 0–9 张图片、0–3 个音频。' : '必须 1–9 张图片，不支持音频。'}均不支持视频。媒体支持公网 URL 或 COS 相对路径。渠道 Key 待后台填写；鉴权 X-Auth-Token。`,
    route_path: '/openapi/tasks/create',
    poll_path: '/openapi/tasks/${up_task_id}',
    is_async: 1,
    proxy_content: 0,
    req_mapping: `$merge([
      {
        "template_key": "${template.name}",
        "extra_data": { "text": prompt },
        "config_values": $merge([
          { "mode": "reference", "duration": $exists(seconds) ? $number(seconds) : 5, "aspect": $exists(aspect_ratio) ? aspect_ratio : "9:16" },
          $exists(resolution) ? { "resolution": resolution } : {}
        ]),
        "priority": 0
      },
      $count(images) > 0 ? { "image_path": images } : {}${template.audio ? ',\n      $count(audios) > 0 ? { "audio_path": audios } : {}' : ''}
    ])`,
    resp_mapping: `{
      "task_id": data.task_id,
      "status": "queued",
      "progress": 0,
      "model": "${template.name}",
      "object": "video"
    }`,
    poll_mapping: `(
      $status := data.status;
      $state := $status = "pending" ? "queued" : (($status = "preparing" or $status = "running") ? "processing" : ($status = "canceled" ? "failed" : $status));
      {
        "status": $state,
        "progress": $state = "completed" ? 100 : ($exists(data.progress) ? data.progress : 0),
        "video_url": data.result_oss_url,
        "object": $state = "completed" ? data.result_oss_url : "video.generation",
        "model": "${template.name}",
        "created_at": data.created_at,
        "error": $exists(data.error) ? data.error : ($exists(data.error_message) ? data.error_message : ($state = "failed" ? ($exists(data.msg) ? data.msg : ($exists(msg) ? msg : $status)) : null))
      }
    )`
}));
module.exports = { channel, bindings, templates };
