// 无阶未来（Vylai）OpenAPI 的 SD 2.0 Fast 模板配置。
//
// 上游文档：sd20-wan3-75api(3).md「SD 2.0 Fast / Wan 3.0 视频生成 OpenAPI 调用说明」
// - 地址：https://queueapi.vylai.com
// - 鉴权：X-Auth-Token: <API Key>
// - 创建：POST /openapi/tasks/create
// - 轮询：GET  /openapi/tasks/{task_id}
// - 上传（本网关不封装）：POST /openapi/upload/presign + PUT upload_url
//
// 模板：75api-sd20-fast-20260919（SD 2.0 Fast，多模态参考生视频）
// - extra_data.text   必填，视频提示词；素材顺序对应提示词里的「图一」「音频一」「视频一」
// - image_path        图片列表，最多 9 张；公网 http(s) URL 或 COS 相对路径
// - audio_path        音频列表，最多 3 个
// - video_path        视频列表，最多 3 个
// - config_values.mode            reference（默认）/ t2v / first_frame / first_last
// - config_values.duration        number，4–15 的整数秒，默认 5
// - config_values.resolution      480p（默认）/ 720p（小写 p，注意与 Wan 3.0 的大写 P 不同）
// - config_values.ratio           9:16（默认）/ 16:9
// - config_values.watermark       boolean，默认 false
// - config_values.generate_audio  boolean，默认 true
// - priority                      0 普通 / 1 高优先级，默认 0
// - 创建成功要求 HTTP 200 且 data.task_id 非空
// - 状态：pending（排队）/ preparing（准备素材）/ running（生成中）/ completed / failed / canceled
// - 完成结果：data.result_oss_url；失败读取 error_message 与 display_error_message
//
// 上游限制（无法只靠映射表达，需要调用方遵守）：
// - 素材不支持内联 Base64（data: 开头的字符串会被拒绝）。本渠道 channels.convert_base64_to_url = 1，
//   网关会在提交前把请求体里的 data:image/...;base64 转成图床 HTTPS 链接，因此下游传 base64 图片可用；
//   音频/视频没有对应的转换，必须是公网 URL 或 COS 相对路径。
// - config_values 只允许传模板已声明的字段，传未知字段上游返回「未知配置字段」。
// - 模式与素材要匹配：t2v / first_frame / first_last 不允许参考音频或参考视频；
//   first_frame 至少 1 张图片，first_last 至少 2 张图片，reference 可组合图片 / 音频 / 视频。
//
// 该模型与同渠道已有的 75api-minimax-h3-* 绑定共用同一个渠道和同一套轮询映射
// （buildPollMapping 由 scripts/vylai-minimax-config.js 导出），差别只在创建请求模板：
// SD 2.0 Fast 用 config_values.mode + duration + resolution + ratio，
// 而 MiniMax H3 用 config_values.aspect，且不声明 mode。
const { channel: upstreamChannel, buildPollMapping } = require('./vylai-minimax-config');

const MODEL_NAME = '75api-sd20-fast-20260919';
const TEMPLATE_KEY = '75api-sd20-fast-20260919';
const RESOLUTIONS = ['480p', '720p'];
const RATIOS = ['9:16', '16:9'];

const channel = {
    name: 'Vylai MiniMax H3',
    base_url: upstreamChannel.base_url,
    auth_type: upstreamChannel.auth_type
};

// 逻辑模型名里带分辨率的那些模型（11.7 节）：下游按模型名区分 480p / 720p。
// 上游模板本身不区分分辨率，分辨率写在 config_values.resolution 里，所以两条逻辑模型
// 共用同一份请求映射，只在 resolution 上写死各自的档位，且不接受下游覆盖。
const NAMED_MODELS = [
    { model_name: 'seedance-2.0-933-480p', resolution: '480p' },
    { model_name: 'seedance-2.0-933-720p', resolution: '720p' }
];

// 把下游统一模板映射到 SD 2.0 Fast 的创建请求。
// resolutionMode 为 null 时表示「分辨率由下游传，非法值回落 480p」；为具体档位时由模型名写死。
function buildReqMapping({ resolutionMode }) {
    // JSONata 2.2.2：没有 $isArray/$isObject，三元与 and/or 都不短路求值，
    // $number() 对 null / 空串 / 非数字会抛错，所以先用正则确认是纯数字字符串再调用 $number。
    // 上游 duration 要求 4–15 的整数秒，因此把秒数四舍五入成整数后再判区间，越界回落 5。
    // 注意：表达式内部不能写 // 注释，JSONata 会把 / 当成正则起始符并报
    // "Empty regular expressions are not allowed"，说明只写在模板字符串外面。
    const resolutionLine = resolutionMode
        ? `      $res := "${resolutionMode}";`
        : `      $res := $exists(resolution) and $type(resolution) = "string" and resolution in ["${RESOLUTIONS.join('", "')}"] ? resolution : "480p";`;
    return `(
      $toNum := function($v) { $type($v) = "number" ? $v : ($type($v) = "string" and $match($v, /^-?[0-9]+(\\.[0-9]+)?\$/) ? $number($v) : 0) };
      $dur := $round($toNum(seconds));
${resolutionLine}
      $ratio := $exists(aspect_ratio) and $type(aspect_ratio) = "string" and aspect_ratio in ["${RATIOS.join('", "')}"] ? aspect_ratio : "9:16";
      $merge([
        {
          "template_key": "${TEMPLATE_KEY}",
          "extra_data": { "text": prompt },
          "config_values": {
            "mode": $exists(mode) and $type(mode) = "string" and mode in ["reference", "t2v", "first_frame", "first_last"] ? mode : "reference",
            "duration": ($dur >= 4 and $dur <= 15) ? $dur : 5,
            "resolution": $res,
            "ratio": $ratio,
            "watermark": false,
            "generate_audio": true
          },
          "priority": 0
        },
        $count(images) > 0 ? { "image_path": images } : {},
        $count(audios) > 0 ? { "audio_path": audios } : {},
        $count(videos) > 0 ? { "video_path": videos } : {}
      ])
    )`;
}

// 逻辑模型备注：分辨率来源随 resolutionMode 变化。
function buildRemark({ modelName, resolutionMode }) {
    return 'Vylai queueapi.vylai.com；SD 2.0 Fast 模板 ' + TEMPLATE_KEY + '，鉴权 X-Auth-Token。'
        + 'prompt 必填，映射 extra_data.text；seconds 为 4–15 的整数，缺失/越界回落 5；'
        + (resolutionMode
            ? 'resolution 由模型名写死为 ' + resolutionMode + '，下游传 resolution 会被忽略；'
            : 'resolution 支持 ' + RESOLUTIONS.join('/') + '，非法值回落 480p；')
        + 'aspect_ratio 支持 ' + RATIOS.join('/') + '，非法值回落 9:16；'
        + '图片 images 最多 9 张（image_path），音频 audios 最多 3 个（audio_path），视频 videos 最多 3 个（video_path）。'
        + '默认 config_values.mode = reference（多模态参考生），可传 mode 覆盖为 t2v / first_frame / first_last；'
        + 't2v / first_frame / first_last 不允许参考音频或参考视频，first_frame 至少 1 张图、first_last 至少 2 张图。'
        + 'watermark 固定 false、generate_audio 固定 true，下游不可改。'
        + '素材支持公网 URL 或 COS 相对路径；上游拒绝 data: 内联 Base64，'
        + '渠道已开启请求侧 base64 转图床（仅图片），音频/视频必须自己给公网地址。'
        + '状态 pending/preparing/running 归一为 queued/processing，完成结果取 data.result_oss_url 直链返回。';
}

// 生成「逻辑模型 + 绑定」：同一个上游模板与同一份轮询映射，只有请求映射里的分辨率与模型名不同。
function buildModel({ model_name, resolutionMode }) {
    const remark = buildRemark({ modelName: model_name, resolutionMode });
    return {
        model_name,
        resolutionMode,
        upstream_resolution: resolutionMode,
        template_key: TEMPLATE_KEY,
        remark,
        route_path: '/openapi/tasks/create',
        poll_path: '/openapi/tasks/${up_task_id}',
        is_async: 1,
        // 结果 data.result_oss_url 是可直接下载的成品直链，与同渠道 MiniMax H3 绑定保持一致返回直链。
        proxy_content: 0,
        error_passthrough: 1,
        poll_throttle: 0,
        weight: 1,
        status: 1,
        req_mapping: buildReqMapping({ resolutionMode }),
        resp_mapping: `{
      "task_id": data.task_id,
      "status": "queued",
      "progress": 0,
      "model": "${model_name}",
      "object": "video"
    }`,
        poll_mapping: buildPollMapping(model_name)
    };
}

// 下游不传分辨率的通用模型 + 按模型名区分分辨率的两个模型（同一渠道、同一上游模板）。
const bindings = [
    buildModel({ model_name: MODEL_NAME, resolutionMode: null }),
    ...NAMED_MODELS.map(item => buildModel({ model_name: item.model_name, resolutionMode: item.resolution }))
];

const model = bindings[0];
const namedModels = bindings.slice(1);

module.exports = {
    channel,
    channels: [channel],
    model,
    models: [model],
    bindings,
    namedModels,
    buildModel,
    buildReqMapping,
    MODEL_NAME,
    TEMPLATE_KEY,
    RESOLUTIONS,
    RATIOS,
    NAMED_MODELS
};
