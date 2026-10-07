const templates = [
    { name: '75api-minimax-h3-audio-20260911', audio: true, min: 5, max: 15, resolutions: ['480p', '768p'] },
    { name: '75api-minimax-h3-fast-20260911', audio: false, min: 1, max: 15, resolutions: ['480p', '768p'] },
    { name: '75api-minimax-h3-fast-1080p-20260911', audio: false, min: 1, max: 10, resolutions: ['480p', '768p', '1080p'] }
];
const channel = { name: 'Vylai MiniMax H3', base_url: 'https://queueapi.vylai.com', auth_type: 'x-auth-token' };

// 轮询映射由三个模板共用：上游出错时的字段组合并不固定，必须由映射自己兜底。
//   1. 只要响应里出现任何错误信息（error_message / error / display_error_message），
//      就归一为 failed，并把异常信息格式化成单行可读文本放进 error.message；
//   2. status 永远输出 queued / processing / completed / failed 之一。
//      如果上游响应没有 data 包装、或缺少 status，旧映射会输出一个不带 status 的对象，
//      下游拿到后只能一直轮询，表现就是任务永远停在“进行中/未启动”。
//   3. 失败响应固定为下游要求的形状：
//      { status: "failed", progress: 100, object: "video.generation",
//        created_at, completed_at, error: { message, code } }
//      （id / task_id 由 server.js 轮询后覆盖成网关任务号，成功时额外带 video_url）
//  4. error.message 只保留可读正文（去掉 pod 前缀、换行、"For more information check:" 链接，
//      并把上游用词“下载图像失败”统一成“参考图下载失败”）；error.code 按语义归类：
//      reference_image_download_failed / gpu_out_of_memory / content_moderation /
//      video_generation_cancelled，其余回落 video_generation_failed。
// 使用 String.raw 让正则里的反斜杠（\s、\[、\]）原样进入 JSONata 表达式。
const buildPollMapping = modelName => String.raw`(
  $d := $type(data) = "object" ? data : ($type(data) = "array" and $count(data) > 0 and $type(data[0]) = "object" ? data[0] : $);
  $clean := function($v) {(
    $p := $type($v) = "object" ? ($exists($v.message) ? $v.message : ($exists($v.msg) ? $v.msg : ($exists($v.code) ? $v.code : $v))) : $v;
    $text := $exists($p) ? ($type($p) = "string" ? $p : ($type($p) = "null" ? "" : $string($p))) : "";
    $trim($replace($replace($text, /\s+/, " "), /^\[[^\]]+\]\s*/, ""))
  )};
  $num := function($v) {(
    $type($v) = "number" ? $v : ($type($v) = "string" and $match($v, /^-?[0-9]+(\.[0-9]+)?$/) ? $number($v) : 0)
  )};
  $secs := function($v) {(
    $type($v) = "number" ? $floor($v > 100000000000 ? $v / 1000 : $v)
    : ($type($v) = "string" and $match($v, /^[0-9]+$/) ? $floor($number($v) > 100000000000 ? $number($v) / 1000 : $number($v))
    : ($type($v) = "string" and $match($v, /^[0-9]{4}-[0-9]{2}-[0-9]{2}/) ? $floor($toMillis($v) / 1000)
    : null))
  )};
  $status := $lowercase($clean($d.status));
  $detail := $clean($d.error_message);
  $direct := $clean($d.error);
  $display := $clean($d.display_error_message);
  $code := $clean($d.display_error_code);
  $message := $clean($d.message);
  $note := $clean($d.msg);
  $alt := $message != "" ? $message : ($status = "" and $lowercase($note) != "success" and $lowercase($note) != "ok" ? $note : "");
  $errored := $detail != "" or $direct != "" or $display != "";
  $base := $status = "completed" or $status = "succeeded" or $status = "success" or $status = "done" ? "completed"
    : $status = "pending" or $status = "queued" or $status = "unknown" or $status = "waiting" or $status = "created" or $status = "submitted" ? "queued"
    : $status = "preparing" or $status = "running" or $status = "processing" or $status = "in_progress" or $status = "inprogress" or $status = "generating" ? "processing"
    : $status = "failed" or $status = "error" or $status = "failure" or $status = "canceled" or $status = "cancelled" or $contains($status, "fail") or $contains($status, "error") or $contains($status, "cancel") or $contains($status, "reject") or $contains($status, "timeout") or $contains($status, "expire") ? "failed"
    : $status = "" ? "failed"
    : "processing";
  $state := $base = "completed" ? "completed" : ($errored or $base = "failed" ? "failed" : $base);
  $url := $d.result_oss_url ? $d.result_oss_url : ($d.result_url ? $d.result_url : ($d.video_url ? $d.video_url : ($d.url ? $d.url : null)));
  $createdAt := $secs($d.created_at);
  $updatedAt := $secs($d.updated_at);
  $created := $type($createdAt) = "number" ? $createdAt : $floor($millis() / 1000);
  $completed := $type($updatedAt) = "number" ? $updatedAt : $floor($millis() / 1000);
  $text := $detail != "" ? $detail : ($direct != "" ? $direct : ($display != "" ? $display : ($alt != "" ? $alt : ($status = "canceled" or $status = "cancelled" ? "上游任务已取消" : ($status != "" ? "上游任务失败: " & $status : "上游未返回任务状态")))));
  $text := $trim($replace($replace($text, /For more information check:.*$/, ""), "下载图像失败", "参考图下载失败"));
  $low := $lowercase($text);
  $errCode := $contains($low, "参考图下载失败") or $contains($low, "下载图像失败") or ($contains($low, "download") and $contains($low, "image")) ? "reference_image_download_failed"
    : ($contains($low, "out of memory") or $contains($low, "exceed allowed memory") ? "gpu_out_of_memory"
    : ($lowercase($code) = "content_moderation" ? "content_moderation"
    : ($status = "canceled" or $status = "cancelled" ? "video_generation_cancelled"
    : "video_generation_failed")));
  $extra := $state = "completed" ? { "video_url": $url, "completed_at": $completed }
    : $state = "failed" ? { "completed_at": $completed }
    : { "video_url": null };
  $merge([
    {
      "status": $state,
      "progress": $state = "completed" or $state = "failed" ? 100 : $num($d.progress),
      "object": $state = "completed" ? $url : "video.generation",
      "model": "${modelName}",
      "created_at": $created,
      "error": $state = "failed" ? { "message": $text, "code": $errCode } : null
    },
    $extra
  ])
)`;

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
    poll_mapping: buildPollMapping(template.name)
}));
module.exports = { channel, bindings, templates, buildPollMapping };
