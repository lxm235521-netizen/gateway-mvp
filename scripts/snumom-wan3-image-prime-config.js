// snumom（万相 3.0 图生高速版）渠道配置：wan3.0-image-prime。
// 上游文档：创建 POST https://snumom.com/v1/videos，轮询 GET https://snumom.com/v1/videos/{task_id}，
// 下载 GET https://snumom.com/v1/videos/{task_id}/content，Bearer 鉴权。
//
// 上游字段（扁平 OpenAI 风格）：
//   model / prompt / seconds（兼容 duration）/ size（480P|720P|1080P）/ aspect_ratio
//   / reference_images[{url, role}] / reference_audios[{url}] / prompt_extend / parameters / input.media
// 上游创建响应：id / object / status。
// 上游轮询响应：status（queued|not_start|in_progress|completed|failed）/ progress / metadata.url（成片地址）。
//
// wan3.0-image-prime 是「图生高速」档：只支持图片 + 音频参考，禁止 reference_videos
// 和 type 为 video 的 input.media，因此本绑定不映射下游的 videos 字段。
// 计费只按输出时长（图片/音频/文档参考都不计费）：480P $0.15/s，720P $0.18/s，1080P $0.20/s。
//
// 网关下游模板的 resolution 映射到上游 size，size 的语义与上游一致（480P/720P/1080P）；
// 下游的 images / audios 归一成上游的 reference_images / reference_audios：
// 字符串项补默认 role=reference_image，对象项保留 url 与 role（first_frame / last_frame）。

const channel = {
    name: 'Grok Video',
    base_url: 'https://snumom.com',
    auth_type: 'bearer'
};

const MODEL = {
    model_name: 'wan3.0-image-prime',
    displayName: 'Wan 3.0 Image Prime（图生高速）',
    route_path: '/v1/videos',
    poll_path: '/v1/videos/${up_task_id}',
    minSeconds: 2,
    maxSeconds: 30,
    defaultSeconds: 5,
    defaultResolution: '1080P',
    resolutions: ['480P', '720P', '1080P'],
    defaultAspectRatio: 'adaptive',
    maxImages: 10,
    maxAudios: 5,
    remark: 'snumom.com 万相 3.0 图生高速版；上游 model 固定 wan3.0-image-prime；'
        + '创建 POST /v1/videos，轮询 GET /v1/videos/{task_id}。'
        + 'seconds 必传且必须是 2~30 的整数（禁止 -1 智能时长），未传或越界时网关回落到 5 秒；'
        + '上游 seconds 字段类型是字符串，网关统一发整数字符串（例如 "10"），发数字会被上游以 invalid_json 拒绝；'
        + 'resolution 映射上游 size，取值 480P/720P/1080P，未传默认 1080P；'
        + 'aspect_ratio 支持 adaptive/16:9/9:16/1:1 等，首帧模式建议 adaptive，未传默认 adaptive；'
        + '最多 10 张参考图（reference_images，role 可为 reference_image/first_frame/last_frame，'
        + '首尾帧不能与参考图混用）与最多 5 段参考音频（reference_audios）；'
        + '该模型禁止参考视频，绑定不映射下游 videos。'
        + '参考素材必须是公网 HTTP(S) URL，图片 ≤20MB，音频总长 ≤15s、≤15MB。'
        + 'prompt_extend 默认开启（上游提示词智能改写），可通过 prompt_extend=false 或 parameters.prompt_extend=false 关闭。'
        + '生成通常 1~5 分钟，progress 只有 0/30/100 的粗粒度，建议 10~15 秒轮询；'
        + '完成地址在上游 metadata.url，24 小时后失效，因此绑定开启网关内容代理。'
        + '按输出时长计费：480P $0.15/s、720P $0.18/s、1080P $0.20/s，参考图与音频不计费，完成不退还差额。'
};

// 注意：
// - JSONata 表达式里不能写 // 注释（解析器会把 / 当运算符），说明都写在 JS 注释里。
// - $number("abc") 会抛错，因此先取 $number 再判断 $type(...) = "number"。
// - $string(数组) 在多元素时为 undefined、单元素时等于该元素，用它区分「单个字符串」和「数组」，
//   保证传给上游的 reference_images / reference_audios 始终是数组（单个对象不会被 JSONata 折叠）。
// - 上游 seconds 的 Go 字段是 string：传数字会被拒（invalid_json / cannot unmarshal number into
//   Go struct field .Alias.seconds of type string），所以这里先用 $number 校验区间，再 $string 回去，
//   最终发给上游的永远是整数字符串（例如 "10"）。
const bindings = [{
    model_name: MODEL.model_name,
    remark: MODEL.remark,
    route_path: MODEL.route_path,
    poll_path: MODEL.poll_path,
    is_async: 1,
    proxy_content: 1,
    error_passthrough: 1,
    poll_throttle: 1,
    weight: 1,
    status: 1,
    req_mapping: `(
      $hasSeconds := $exists(seconds) and $string(seconds) != "" and $type(seconds) != "null";
      $looksNumeric := $hasSeconds and $count($match($string(seconds), /[^0-9.+-]/)) = 0;
      $parsedSeconds := $looksNumeric ? $number(seconds) : null;
      $secondsValid := $type($parsedSeconds) = "number" and $parsedSeconds >= ${MODEL.minSeconds} and $parsedSeconds <= ${MODEL.maxSeconds};
      $outSeconds := $string($round($secondsValid ? $parsedSeconds : ${MODEL.defaultSeconds}));
      $resolution := $exists(resolution) and $string(resolution) != "" ? $string(resolution) : "${MODEL.defaultResolution}";
      $outSize := ($resolution = "480P" or $resolution = "720P" or $resolution = "1080P") ? $resolution : "${MODEL.defaultResolution}";
      $outAspectRatio := $exists(aspect_ratio) and $string(aspect_ratio) != "" ? aspect_ratio : "${MODEL.defaultAspectRatio}";
      $imageInput := $exists(images) ? images : [];
      $imageIsArray := $exists($imageInput) and $count($imageInput) > 0 and $string($imageInput) != $string($imageInput[0]);
      $imageList := $imageIsArray ? $imageInput : ($count($imageInput) > 0 ? [$imageInput] : []);
      $referenceImages := $count($imageList) = 0 ? []
        : [$map($imageList, function($image) { { "url": $exists($image.url) ? $image.url : $image, "role": $exists($image.role) ? $image.role : "reference_image" } })];
      $audioInput := $exists(audios) ? audios : [];
      $audioIsArray := $exists($audioInput) and $count($audioInput) > 0 and $string($audioInput) != $string($audioInput[0]);
      $audioList := $audioIsArray ? $audioInput : ($count($audioInput) > 0 ? [$audioInput] : []);
      $referenceAudios := $count($audioList) = 0 ? []
        : [$map($audioList, function($audio) { { "url": $exists($audio.url) ? $audio.url : $audio, "role": $exists($audio.role) ? $audio.role : "reference_image" } })];
      $parameters := $exists(parameters.prompt_extend) ? parameters : ($exists(prompt_extend) ? { "prompt_extend": prompt_extend } : {});
      $merge([
        {
          "model": "${MODEL.model_name}",
          "prompt": prompt,
          "seconds": $outSeconds,
          "size": $outSize,
          "aspect_ratio": $outAspectRatio
        },
        $count($referenceImages) > 0 ? { "reference_images": $referenceImages } : {},
        $count($referenceAudios) > 0 ? { "reference_audios": $referenceAudios } : {},
        $exists(input) ? { "input": input } : {},
        $count($keys($parameters)) > 0 ? { "parameters": $parameters } : {}
      ])
    )`,
    resp_mapping: `{
      "task_id": $exists(task_id) ? task_id : id,
      "id": $exists(id) ? id : task_id,
      "status": $exists(status) ? status : "queued",
      "progress": $exists(progress) ? progress : 0,
      "object": $exists(object) ? object : "video",
      "model": $exists(model) ? model : "${MODEL.model_name}",
      "created_at": created_at
    }`,
    poll_mapping: `(
      $state := $exists(status) ? $lowercase($string(status)) : "";
      $normalized := $state = "completed" ? "completed"
        : (($state = "failed" or $state = "error" or $state = "canceled" or $state = "cancelled") ? "failed"
        : (($state = "queued" or $state = "not_start" or $state = "pending" or $state = "submitted") ? "queued" : "processing"));
      $upstreamUrl := $exists(metadata.url) ? metadata.url
        : ($exists(video_url) ? video_url : ($exists(result_url) ? result_url : ($exists(url) ? url : "")));
      $errorInfo := $exists(error) ? error : ($exists(message) ? message : ($normalized = "failed" ? ("上游任务失败: " & $state) : null));
      {
        "status": $normalized,
        "progress": $normalized = "completed" ? 100 : ($exists(progress) ? progress : 0),
        "video_url": $normalized = "completed" ? $upstreamUrl : "",
        "result_url": $normalized = "completed" ? $upstreamUrl : "",
        "object": $normalized = "completed" ? $upstreamUrl : "video.generation",
        "model": $exists(model) ? model : "${MODEL.model_name}",
        "seconds": $exists(seconds) ? seconds : null,
        "size": $exists(size) ? size : null,
        "aspect_ratio": $exists(aspect_ratio) ? aspect_ratio : null,
        "created_at": $exists(created_at) ? created_at : $floor($millis() / 1000),
        "completed_at": $exists(completed_at) ? completed_at : null,
        "error": $errorInfo
      }
    )`
}];

module.exports = { channel, bindings, model: MODEL };
