// 佳速（jiasuapi）MiniMax H3 渠道配置。
//
// 上游文档：https://aijiasu.apifox.cn/api-520050937 「MiniMax H3 视频创建（专用）」
// - 创建：POST https://ai.jiasuapi.com/v1/video/generations（与「创建视频(推荐)」同一接口）
// - 轮询：GET  https://ai.jiasuapi.com/v1/videos/tasks/{task_id}
//   （文档另有 GET /v1/video/generations/{task_id}，标注「无用」，不使用）
// - 鉴权：Authorization: Bearer <token>；Content-Type: application/json
// - 与通用视频接口的区别：参考视频必须写成对象并带 duration_seconds（该视频真实时长，秒）。
//
// 上游字段（MiniMax H3 专用）：
// - model        固定 minimax-h3-933-2k-支持真人（注意：见文件末尾「模型可用性」）
// - prompt       必填，1–6000 字符
// - duration     可选，integer；文档写「当前固定 15（不传或传其它值均按 15）」
// - ratio        可选，16:9 / 9:16 / 1:1（别名 aspect_ratio）；其它值按 16:9
// - resolution   可选，固定 2k（不传默认 2k）
// - images       可选，URL 或 {url}；公网 HTTPS；最多 9 张
// - videos       可选，[{url, duration_seconds, mime?}]；最多 3 个；
//                duration_seconds 每项必填且必须与视频真实时长一致，多条合计 ≤ 15 秒
// - audios       可选，URL 或 {url, mime?}；最多 3 个
// - materials    可选，[{type, url, duration_seconds?}]，type=video 时必填 duration_seconds
//   合计限制：图 ≤ 9、视频 ≤ 3、音频 ≤ 3，三者合计 ≤ 10；超限或缺 duration_seconds 上游提交前拒绝且不扣费。
// - 创建响应：id / object / model / status / progress / created_at / completed_at? /
//   expires_at? / seconds（字符串）/ size / error{message,code}? / result_urls[]?
// - 轮询响应：与「查询视频(推荐)」相同，结果在 result_urls[]（m.jiasuapi.com 公开 CDN 直链）
//
// 网关不支持下游传 {url, duration_seconds} 之类的对象透传，因此需要参考视频时，
// 下游要在网关统一模板里直接传上游要求的对象结构：{"url": "...", "duration_seconds": 10}。
// 这是本模型与其它模型最主要的差异。
//
// 模型可用性（2026-10 实测，用本渠道密钥）：
//   GET /v1/models 列出的是 minimax-h3；文档写的 minimax-h3-933-2k-支持真人
//   提交时被上游以 503 model_not_found「No available channel for this model under the current group」拒绝，
//   与乱写的模型名表现一致，说明该名字在当前密钥的分组下无可用渠道。
//   实测 minimax-h3 带 prompt 提交返回 200 + task id，因此上游固定用 minimax-h3。
// 若上游之后开通了 2k/真人 档位，可用环境变量 MINIMAX_H3_MODEL_NAME 覆盖上游模型名。
const MODEL_NAME = process.env.MINIMAX_H3_MODEL_NAME || 'minimax-h3';

const channels = [
    {
        name: '佳速 Seedance',
        base_url: 'https://ai.jiasuapi.com/v1',
        auth_type: 'bearer',
        api_key: process.env.JIASU_API_KEY || 'sk-cOHSWwWodQUY3KYqLtF1V3mxRJHZEADeNhps6hmfAxEm156o',
        status: 1
    }
];

// 逻辑模型名（下游调用的名字）与上游真实模型名分开：上游固定 minimax-h3。
const models = [
    {
        model_name: 'minimax-h3-2k',
        upstream_model_name: MODEL_NAME,
        // 早期版本曾用文档里的 minimax-h3-933-2k-支持真人 作为逻辑模型名，改名时用于识别并复用旧记录。
        legacy_model_names: ['minimax-h3-933-2k-支持真人'],
        remark: '佳速 ai.jiasuapi.com；MiniMax H3（专用格式）。上游 model 固定 ' + MODEL_NAME + '；prompt 必填 1–6000 字符。'
            + '下游 seconds 只在 1–15 时映射 duration（上游当前固定 15，不传或传其它值都按 15）。'
            + 'aspect_ratio 映射 ratio（16:9 / 9:16 / 1:1），未传或非法时按 16:9；resolution 固定 2k（不传即 2k）。'
            + '参考图 images 最多 9 张（URL 或 {url}，公网 HTTPS）。'
            + '参考视频必须写成 {"url": "...", "duration_seconds": 10}（duration_seconds 为该视频真实时长，必填，'
            + '多条合计 ≤ 15 秒，最多 3 个）；参考音频 audios 最多 3 个；图+视频+音频合计 ≤ 10。'
            + '超限或缺 duration_seconds 上游提交前拒绝、不扣费。'
            + '上游状态 queued/in_progress/completed/failed/unknown，完成结果在 result_urls[]，'
            + '为 m.jiasuapi.com 公开 CDN 直链。'
            + '说明：上游 /v1/models 只暴露 minimax-h3；文档里的 minimax-h3-933-2k-支持真人 '
            + '实测返回 503 model_not_found（当前分组无可用渠道），故上游固定用 minimax-h3。'
            + '逻辑模型名曾用 minimax-h3-933-2k-支持真人，现改名为 minimax-h3-2k。'
    }
];

const bindings = models.map(model => ({
    model_name: model.model_name,
    // 改名复用要用到旧名字，必须一起带进 binding，否则配置脚本看不到旧记录会新建重复模型。
    legacy_model_names: model.legacy_model_names || [],
    remark: model.remark,
    route_path: '/video/generations',
    poll_path: '/videos/tasks/${up_task_id}',
    is_async: 1,
    status: 1,
    weight: 1,
    error_passthrough: 1,
    poll_throttle: 0,
    // 结算是 m.jiasuapi.com 公开 CDN 直链，与同渠道 Seedance 绑定保持一致用网关代理，
    // 避免结果链接在客户端侧受跨域/过期影响。
    proxy_content: 1,
    // JSONata 的三元与 and/or 都不短路径求值，$number() 对 null / 空串 / 非数字会直接抛错，
    // 而且即使写在条件分支里也会被求值，所以必须先用正则确认是纯数字字符串再调用 $number。
    req_mapping: `(
      $toDur := function($v) { $type($v) = "number" ? $v : ($type($v) = "string" and $match($v, /^-?[0-9]+(\\.[0-9]+)?\$/) ? $number($v) : 0) };
      $dur := $toDur(seconds);
      $merge([
        {
          "model": "${model.upstream_model_name}",
          "prompt": prompt,
          "resolution": "2k",
          "ratio": $exists(aspect_ratio) ? aspect_ratio : "16:9"
        },
        ($dur >= 1 and $dur <= 15) ? { "duration": $dur } : {},
        $exists(images) ? { "images": images } : {},
        $exists(videos) ? { "videos": videos } : {},
        $exists(audios) ? { "audios": audios } : {}
      ])
    )`,
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
      $errMessage := $exists(error) ? ($type(error) = "object" ? ($exists(error.message) ? error.message : error) : error) : ($exists(message) ? message : null);
      {
        "created_at": $exists(created_at) ? created_at : $floor($millis() / 1000),
        "model": $exists(model) ? model : "${model.model_name}",
        "object": $state = "completed" ? $resultUrl : "video.generation",
        "progress": $state = "completed" ? 100 : ($exists(progress) ? progress : 0),
        "status": $state,
        "video_url": $resultUrl,
        "result_url": $resultUrl,
        "error": $errMessage,
        "completed_at": $exists(completed_at) ? completed_at : null
      }
    )`
}));

module.exports = { channel: channels[0], channels, models, bindings, MODEL_NAME };