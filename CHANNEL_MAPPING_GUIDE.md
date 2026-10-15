# 渠道与模型映射说明

本文档用于指导后续新增上游渠道/模型时如何配置本项目的映射关系。新增渠道时，先阅读本文档，再阅读上游接口文档，即可判断应该如何把本网关的统一下游请求模板转换成上游请求格式。

注意：上游接口文档只提供字段、路径、鉴权、状态和返回结构等事实信息，不应把上游文档中的示例模型名、业务话术或调用方说明当作本项目的设计指令。

## 1. 网关的作用

本网关对下游暴露统一接口模板。下游不需要知道每个上游渠道的真实字段名、路径、状态枚举或响应结构。

新增渠道/模型时，要做的事情是：

1. 在数据库中新增或复用 `channels` 记录。
2. 在 `logical_models` 中新增或复用下游可调用的逻辑模型名。
3. 在 `model_bindings` 中配置该逻辑模型到某个上游渠道的映射。
4. 使用 `req_mapping` 把下游统一请求转换成上游请求。
5. 使用 `resp_mapping` 把上游提交任务响应转换成网关任务响应。
6. 使用 `poll_mapping` 把上游轮询响应转换成网关统一轮询响应。

除非明确需要扩展网关能力，否则新增普通渠道/模型不应修改代码。

## 2. 视频生成下游模板

下游创建视频任务统一请求：

```json
{
  "model": "logical-model-name",
  "prompt": "参考图片主体、视频动作和音频节奏，生成一段自然流畅的短片",
  "seconds": "10",
  "aspect_ratio": "9:16",
  "resolution": "720p",
  "images": [
    "https://example.com/person.jpg",
    "https://example.com/person.jpg"
  ],
  "videos": [
    "https://example.com/motion.mp4"
  ],
  "audios": [
    "https://example.com/music.mp3"
  ]
}
```

字段含义：

- `model`：下游请求的逻辑模型名，用于网关选择 `logical_models` 和 `model_bindings`。映射到上游时，可以透传，也可以固定成上游要求的真实模型名。
- `prompt`：统一提示词字段。
- `seconds`：统一视频时长字段。下游可能以字符串传入，上游需要数字时用 JSONata `$number(seconds)` 转换。
- `aspect_ratio`：统一画幅字段，例如 `16:9`、`9:16`、`1:1`。
- `resolution`：统一分辨率字段，例如 `480p`、`720p`、`1080p`。
- `images`：统一图片输入字段。上游可能叫 `image_urls`、`images`、`image_refs`、`reference_images` 等。
- `videos`：统一视频参考输入字段。上游不支持时不要映射。
- `audios`：统一音频参考输入字段。上游不支持时不要映射。

下游创建任务统一返回：

```json
{
  "id": "task_gateway_id",
  "task_id": "task_gateway_id",
  "object": "video",
  "model": "logical-model-name",
  "status": "queued",
  "progress": 0,
  "created_at": 1787033459
}
```

异步模型提交上游后，网关会生成自己的 `gw_task_id` 返回给下游。`resp_mapping` 必须至少映射出上游任务号到 `task_id`，这样网关才能保存上游任务号并用于后续轮询。

## 3. 视频轮询统一模板

下游轮询：

```http
GET /v1/videos/{gateway_task_id}
Authorization: Bearer sk-your-api-key
```

进行中返回建议格式：

```json
{
  "created_at": 1787033450,
  "id": "task_gateway_id",
  "model": "logical-model-name",
  "object": "video.generation",
  "progress": 30,
  "status": "processing",
  "task_id": "task_gateway_id"
}
```

完成返回建议格式：

```json
{
  "created_at": 1787036583,
  "id": "task_gateway_id",
  "model": "logical-model-name",
  "object": "https://gateway.example.com/v1/videos/task_gateway_id/content",
  "progress": 100,
  "status": "completed",
  "task_id": "task_gateway_id",
  "video_url": "https://gateway.example.com/v1/videos/task_gateway_id/content"
}
```

失败返回建议格式（`error` 必须是对象，不是字符串）：

```json
{
  "created_at": 1785203530,
  "completed_at": 1785203783,
  "id": "task_gateway_id",
  "model": "logical-model-name",
  "object": "video.generation",
  "progress": 100,
  "status": "failed",
  "task_id": "task_gateway_id",
  "error": {
    "code": "video_generation_failed",
    "message": "Video generation failed"
  }
}
```

`error.code` 只保留语义白名单：`video_generation_failed`、`video_generation_cancelled`、
`reference_image_download_failed`、`gpu_out_of_memory`、`content_moderation`。
其余取值（包括上游自定义的 `error_code`，例如 `upstream_failed`）一律回落
`video_generation_failed`，下游因此可以稳定按码分支。

当前代码会在轮询后自动覆盖 `id` 和 `task_id` 为网关任务号。`poll_mapping` 只需要把上游状态、进度、错误和真实结果 URL 映射出来。

`server.js` 在 `poll_mapping` 求值之后还会统一归一化 `error`，所以映射写得不规范也不会漏到下游：

- 映射输出 `error` 为字符串（旧的扁平写法，错误码另放顶层 `error_code`）时，网关改写成
  `{ code, message }`；`code` 缺失或不在白名单内时回落 `video_generation_failed`。
- 映射输出 `error` 已是对象时，取其中的 `message` / `msg` / `error` / `detail` / `reason` 作为
  `message`，取 `code` / `error_code` / `type` 作为 `code`，再按上面的白名单归一。
- `status` 为 `failed` 但完全没有错误文本时，补 `message: "Video generation failed"`，
  保证失败任务永远可读；非失败状态的 `error` 固定为 `null`（连带的顶层 `error_code` 也置 `null`）。
- 顶层 `error_code` 保留为 `error.code` 的镜像，只读旧字段的下游不会与新字段产生分歧。

关键：归一化发生在网关侧而不是映射里，因此提交时已冻结 `poll_mapping_snapshot` 的历史任务
同样生效——只修 `poll_mapping` 不会改变旧任务的返回。

重要：当前 `/v1/videos/{task_id}/content` 会读取 `poll_mapping` 结果中的 `video_url` 字段。因此如果上游完成后返回字段叫 `result_url`、`url`、`data[0].url` 等，必须在 `poll_mapping` 中映射为 `video_url`。

视频内容接口 `GET /v1/videos/{task_id}/content` 支持匿名访问，无需携带 Authorization。
开启网关代理后，浏览器或播放器可直接使用该链接，支持 Range 请求。
网关访问同源视频地址时使用任务保存的上游密钥与鉴权方式；跨域视频地址首次不附加渠道密钥，保留链接自身的签名或 token 参数。
跨域下载返回 401/403 且任务保存了上游密钥时，网关内部携带该密钥重试一次，沿用保存的 Bearer 或 X-Auth-Token 鉴权方式，并保留 Range/If-Range 请求头。
首次 401/403 不直接返回下游；重试成功则返回视频，仍失败则返回网关 502 和最终 upstream_status。其他 HTTP 错误或没有保存密钥时不重试。
创建任务和查询状态仍需要 Bearer 鉴权。

## 4. 图片生成下游模板

下游图片接口：

```http
POST /v1/images/generations
POST /v1/images/edits
Authorization: Bearer sk-your-api-key
Content-Type: application/json
```

文生图通常使用 `/v1/images/generations`。图生图可以继续使用该路径，也可以按模型的公开定义使用 `/v1/images/edits`。两个入口都接收相同的统一 JSON 字段；下游插件不直接复刻上游 multipart 或专用字段。

统一请求体：

```json
{
  "model": "logical-image-model-name",
  "prompt": "一只在月光下的猫，插画风格",
  "quality": "high",
  "n": 1,
  "size": "16:9",
  "response_format": "url",
  "images": [
    "base64、data URL 或 HTTPS URL"
  ]
}
```

字段含义：

- `model`：`logical_models.model_name`，下游必须原样发送，不能替换成上游真实模型名。
- `prompt`：统一图片提示词字段。
- `quality`：统一质量字段，取值和默认值由逻辑模型定义。
- `n`：生成数量，取值范围由逻辑模型定义。
- `size`：统一尺寸字段。它可以表示画幅或像素尺寸，具体语义必须记录在逻辑模型配置或 `logical_models.remark` 中。
- `response_format`：期望的返回形式，例如 `url` 或 `b64_json`。
- `images`：图生图参考图，可使用 Base64、data URL 或 HTTPS URL。文生图应省略；没有参考图时不发送空数组。

下游图片返回建议格式：

```json
{
  "model": "logical-image-model-name",
  "url": "base64、data URL 或 HTTPS URL"
}
```

图片接口同步返回，不创建视频任务，也不使用轮询流程。映射应优先把结果归一到顶层 `url`；Base64 结果也可归一到顶层 `b64_json`。为兼容 OpenAI 风格调用方，响应还可保留 `data[0].url` 或 `data[0].b64_json`，但不能要求插件只解析未归一的上游结构。

新增图片模型时同样遵循统一字段到上游字段的映射原则。若上游是 OpenAI 兼容图片接口，通常映射 `prompt`、`quality`、`n`、`size`、`response_format`、`images` 即可。若上游需要 multipart，则 `req_mapping` 输出带 `_request_format`、`fields`、`files`、`_file_fields` 的对象，具体以 `server.js` 中 multipart 支持为准。multipart 转换属于网关绑定，不能下放到插件实现。

模型支持文生图还是图生图、参考图数量和大小限制、`size` 取值、质量选项、输出格式及扩展名，都应写入本地模型配置或 `logical_models.remark`，供插件接入时读取。不要把分辨率或任务模式拼接到逻辑模型名中，除非它们本来就是网关公开模型名的一部分。

## 5. 数据库配置字段

### channels

- `name`：渠道名称，便于后台识别。
- `base_url`：上游基础地址，不含具体接口路径时最好不要以多余路径结尾。例如上游完整地址是 `https://example.com/v1/videos`，则 `base_url` 可填 `https://example.com/v1`，`route_path` 填 `/videos`。
- `api_key`：上游固定密钥。若为空，网关会尝试使用下游传入的 Bearer key 透传给上游。
- `status`：`1` 启用，`0` 禁用。
- `convert_base64_to_url`：`1` 时，提交到该渠道前会将请求体中 `data:image/...;base64,...` 图片上传到图床（默认 Zipline `https://files.mmg.lat/api/upload`），并替换为返回的 HTTPS URL；`0` 保持原样。
- `convert_resp_base64_to_url`：`1` 时，该渠道**返回**给下游之前会把响应体里的 `data:image/...`、裸 base64（仅限 `b64_json`/`url`/`image_urls`/`image`/`data`/`content` 等图片字段名，且长度 ≥128 的纯 base64 字符）以及 Markdown 图片里的 data URL 上传到同一个图床，替换成 HTTPS 链接；`0` 保持原样。
  上游只按 base64 返回图片、而下游要求 http 链接时必须打开这个开关。上传失败不会让请求失败，
  网关会记日志并原样返回上游结果（详见第 11.6 节）。

### 图床（Zipline，请求/响应两侧共用）

两个开关共用同一个上传函数 `uploadBase64Image`，行为如下：

- 上传：`POST {IMAGE_BED_UPLOAD_URL}`，`multipart/form-data`，字段名 `file`，
  文件名按真实嗅探出的扩展名（`image.png`/`image.jpg`/`image.gif`/`image.webp`），并带真实 content-type。
- 鉴权：默认请求头 `Authorization: <IMAGE_BED_TOKEN>`，token 形如 `zk_...`（Zipline 的 key 直接放该头即可，
  加不加 `Bearer ` 前缀服务端都接受）。另外默认带 `x-zipline-no-json: true`，让图床**直接回纯文本 URL**。
- 回答解析兼容两种形态：纯文本 URL（默认），以及 JSON（`{"files":[{"url":"..."}]}`，或顶层 `url`）。
  两种都能解析出链接；解析不出链接时按上传失败处理。
- 默认值写在 `server.js` 顶部，可用环境变量覆盖：
  `IMAGE_BED_UPLOAD_URL`（默认 `https://files.mmg.lat/api/upload`）、
  `IMAGE_BED_TOKEN`（默认项目内置 key，轮换 key 时改这里）、
  `IMAGE_BED_AUTH_HEADER`（默认 `Authorization`）、
  `IMAGE_BED_NO_JSON=0` 可关闭“要求纯文本回答”。
- 自检：`node tools/check-image-bed.js`（上传 1×1 PNG，分别验证纯文本与 JSON 两种回答的解析）。
- 注意 Zipline 免费额度下上传的文件**会到期自动删除**（实测返回体里的 `deletesAt` 约 2 天后）。
  对"生成后立刻把链接交给上游/下游"的用法没有影响，但如果指望图床长期保管图片，需要自建或付费实例。

### logical_models

- `model_name`：下游请求体中的 `model` 名称。模型名称本身不用等于上游真实模型名。
- `status`：`1` 启用，`0` 禁用。

### model_bindings

- `logical_model_id`：绑定的逻辑模型。
- `channel_id`：绑定的上游渠道。
- `route_path`：提交任务或同步请求的上游路径。
- `poll_path`：异步任务轮询路径，可使用 `${up_task_id}` 占位符。
- `api_key`：该绑定专用上游密钥，优先级高于 `channels.api_key`。
- `is_async`：视频任务通常为 `1`。同步返回结果的模型为 `0`。
- `proxy_content`：是否由网关代理该绑定生成的视频。上游成品链接需要鉴权时设为 `1`；公开直链设为 `0`。
  开启后 `/content` 直接返回视频流，并转发 Range 相关请求和响应头；关闭时保持返回 `{ "url": "上游地址" }`。
- `req_mapping`：JSONata 表达式，下游请求体 -> 上游请求体。
- `resp_mapping`：JSONata 表达式，上游提交响应 -> 网关提交响应。异步任务必须输出 `task_id`。
- `poll_mapping`：JSONata 表达式，上游轮询响应 -> 网关轮询响应。完成时必须输出 `video_url`。
- `weight`：多个绑定可按权重随机路由。
- `status`：`1` 启用，`0` 禁用。

上游密钥优先级：下游透传 key > `model_bindings.api_key` > `channels.api_key`。当前代码在调用 `sendMappedPost` 时如果存在 `req.passThroughKey` 会优先使用它；如果下游使用的是网关自己的 key，则会使用绑定或渠道里配置的上游 key。

## 6. JSONata 映射原则

新增映射时遵守以下原则：

- 下游字段名以本网关模板为准，不要要求下游改成上游字段名。
- 上游不支持的字段不要映射，例如上游不支持 `videos` 或 `audios` 时直接忽略。
- 上游字段有默认值要求时，在 `req_mapping` 中补默认值。
- 下游字符串数字传给上游数字字段时，用 `$number(...)`。
- 反过来，上游字段是字符串类型（部分上游的 Go 结构体把 `seconds` 声明成 `string`）时必须发字符串：
  用 `$string($round(...))` 输出整数字符串，否则上游会以 `invalid_json` /
  `cannot unmarshal number into Go struct field ... of type string` 拒绝整个请求。
  以本仓库的 snumom `wan3.0-image-prime` 绑定为例，`$number` 只用于区间校验，落到请求体里的仍是 `"10"` 这样的字符串。
  上游是 Go 网关时字段声明与文档示例往往以字符串形式出现（例如文档示例写 `"seconds": "10"`），
  新增渠道时优先按文档示例的字面类型映射。
- 上游模型名固定时，在 `req_mapping` 中写死真实上游模型名。
- 异步提交响应必须把上游任务 ID 映射成 `task_id`。
- 轮询完成响应必须把上游成品 URL 映射成 `video_url`。
- 状态枚举要归一到网关模板常用值：`queued`、`processing`、`completed`、`failed`。
- 轮询映射必须保证 `status` 一定有值：上游响应缺 `status`、缺 `data` 包装或直接返回错误体时，
  要输出 `failed`（并带上可读的 `error`），否则下游拿到没有状态的响应只会一直轮询。
- 上游出错字段名和时机都不固定：只要响应里出现错误信息（例如 `error`、`error_message`、
  `display_error_message`），就归一为 `failed`，不要管上游 `status` 是否已经翻到失败态。

常用请求映射骨架：

```jsonata
{
  "model": "UPSTREAM_MODEL_NAME",
  "prompt": prompt,
  "seconds": $number(seconds),
  "resolution": resolution,
  "aspect_ratio": aspect_ratio,
  "image_urls": images
}
```

带默认值和可选字段的请求映射骨架：

```jsonata
$merge([
  {
    "model": "UPSTREAM_MODEL_NAME",
    "prompt": prompt,
    "seconds": $number(seconds),
    "resolution": $exists(resolution) ? resolution : "480p",
    "aspect_ratio": $exists(aspect_ratio) ? aspect_ratio : "16:9"
  },
  $exists(images) ? { "image_urls": images } : {},
  $exists(mode) ? { "mode": mode } : {}
])
```

常用异步提交响应映射骨架：

```jsonata
{
  "task_id": $exists(task_id) ? task_id : id,
  "id": $exists(id) ? id : task_id,
  "status": status,
  "progress": $exists(progress) ? progress : 0,
  "object": $exists(object) ? object : "video",
  "model": model,
  "created_at": created_at
}
```

常用轮询映射骨架：

```jsonata
{
  "created_at": created_at,
  "model": model,
  "object": status = "completed" ? result_url : "video.generation",
  "progress": $exists(progress) ? progress : 0,
  "status": status = "in_progress" ? "processing" : ((status = "unknown" or status = "queued" or status = "pending") ? "queued" : status),
  "video_url": result_url,
  "result_url": result_url,
  "error": error,
  "completed_at": completed_at
}
```

## 7. 新增渠道检查清单

### 7.1 视频渠道

阅读上游文档后，逐项确认：

1. 上游提交任务完整 URL 是什么？拆成 `channels.base_url` 和 `model_bindings.route_path`。
2. 上游轮询 URL 是什么？配置为 `poll_path`，用 `${up_task_id}` 替代任务号。
3. 上游鉴权是否是 Bearer key？固定 key 应放在 `channels.api_key` 或 `model_bindings.api_key`。
4. 上游真实模型名是什么？在 `req_mapping` 中固定或从下游 `model` 透传。
5. 上游时长字段叫什么？由下游 `seconds` 映射过去，必要时 `$number(seconds)`。
6. 上游画幅字段叫什么？由下游 `aspect_ratio` 映射过去。
7. 上游分辨率字段叫什么？由下游 `resolution` 映射过去。
8. 上游图片字段叫什么？通常由下游 `images` 映射过去。
9. 上游是否支持视频参考 `videos`？不支持就忽略。
10. 上游是否支持音频参考 `audios`？不支持就忽略。
11. 上游提交响应中的任务号字段叫什么？映射为 `task_id`。
12. 上游轮询状态有哪些？映射为 `queued`、`processing`、`completed`、`failed`。
13. 上游完成后的结果 URL 字段叫什么？映射为 `video_url`。
14. 上游失败错误字段叫什么？尽量映射为 `error`。
15. 上游规格限制是什么？如果只能靠映射表达式表达默认值就写进 `req_mapping`；如果需要复杂校验，记录在渠道备注或交给调用方遵守。
16. 上游成品链接是否需要鉴权？需要时开启绑定的“视频内容访问：网关代理”，公开链接则保持“返回直链”。
17. 新任务会保存代理开关快照，避免任务生成期间修改绑定配置影响已提交任务；旧任务没有快照时回看当前绑定配置。

### 7.2 图片渠道

阅读上游文档后，逐项确认：

1. 下游公开入口使用 `/v1/images/generations` 还是 `/v1/images/edits`。
2. 上游完整 URL 如何拆成 `channels.base_url` 和 `model_bindings.route_path`。
3. 上游鉴权方式及密钥应放在渠道还是绑定中。
4. 上游真实模型名如何由下游逻辑模型名映射。
5. 模型支持文生图、图生图还是两者。
6. `prompt`、`quality`、`n`、`size` 和 `response_format` 分别映射到哪些上游字段。
7. 参考图是否必填，支持的输入形式、最大数量和大小限制是什么。
8. 上游是否要求 multipart；需要时由 `req_mapping` 输出网关支持的 multipart 描述对象。
9. 上游结果是 URL、data URL 还是 Base64，如何通过 `resp_mapping` 归一为顶层 `url` 或 `b64_json`。
10. 支持的画幅、像素尺寸、质量和输出格式是否已记录在本地配置或 `logical_models.remark`。
11. 使用构造请求和模拟响应验证映射，不发送可能计费的真实生成请求，除非用户明确授权。

## 8. Quality V4 示例映射

上游文档信息：

- Base URL：`https://julun.cc/v1`
- 提交接口：`POST /videos`
- 轮询接口：`GET /videos/{id}`
- 上游模型名：`Quality V4`
- 图片字段：`image_urls`
- 支持时长：`5`、`10`、`15`
- 支持分辨率：`480p`、`720p`，其中 `720p` 只能配 `10s`
- 完成结果字段：`result_url`
- 上游进行中状态：`unknown`、`queued`、`in_progress`
- 上游终态：`completed`、`failed`

推荐配置：

- `channels.name`：`Julun Quality V4`
- `channels.base_url`：`https://julun.cc/v1`
- `logical_models.model_name`：按业务需要命名，下游请求时使用这个名字。
- `model_bindings.route_path`：`/videos`
- `model_bindings.poll_path`：`/videos/${up_task_id}`
- `model_bindings.is_async`：`1`
- `model_bindings.proxy_content`：`1`，因为上游 `result_url` 下载时要求携带鉴权信息。

`req_mapping`：

```jsonata
$merge([
  {
    "model": "Quality V4",
    "prompt": prompt,
    "seconds": $number(seconds),
    "resolution": $exists(resolution) ? resolution : "480p",
    "aspect_ratio": $exists(aspect_ratio) ? aspect_ratio : "16:9"
  },
  $exists(images) ? { "image_urls": images } : {},
  $exists(mode) ? { "mode": mode } : {}
])
```

`resp_mapping`：

```jsonata
{
  "task_id": $exists(task_id) ? task_id : id,
  "id": $exists(id) ? id : task_id,
  "status": status,
  "progress": $exists(progress) ? progress : 0,
  "object": $exists(object) ? object : "video",
  "model": model,
  "created_at": created_at
}
```

`poll_mapping`：

```jsonata
{
  "created_at": created_at,
  "model": $exists(model) ? model : "Quality V4",
  "object": status = "completed" ? result_url : "video.generation",
  "progress": $exists(progress) ? progress : 0,
  "status": status = "in_progress" ? "processing" : ((status = "unknown" or status = "queued" or status = "pending") ? "queued" : status),
  "video_url": result_url,
  "result_url": result_url,
  "error": error,
  "completed_at": completed_at
}
```

Quality V4 不支持下游模板中的 `videos` 和 `audios`，因此该绑定不映射这两个字段。

## 9. 提示词优化（可选，按逻辑模型开启）

部分下游用户写的提示词质量不高，可以让网关在转发上游之前，先把用户提示词和输入图片交给一个
OpenAI 兼容的「提示词优化」服务改写，再用改写结果替换原提示词。该能力属于网关的请求预处理，
默认关闭，只有显式开启的逻辑模型才会触发，其余模型完全不受影响。

### 9.1 数据流

1. 下游请求先做请求体校验，并选出该逻辑模型的一个 `model_bindings`（多绑定时按权重随机）。
2. 若该逻辑模型开启优化，网关从原始请求体中取出提示词正文与输入图片。
   - 提示词字段优先级：最后一条 `role=user` 的 `messages[].content` > `prompt` > `text` > `query` > `message` > `input` > `description`。
   - `messages[].content` 为数组时取第一个 `type=text` 的片段；优化结果写回同一位置，其余片段保持不变。
   - 媒体字段：`images`、`image`、`image_url`、`image_urls`、`init_image`、`first_frame`、`last_frame`、`reference_images`、`videos`、`audios` 等；支持字符串、数组和 `{ "url": ... }` 对象。
3. 校验图片（默认最多 9 张、单张 ≤ 8MB）。优化服务只接受 `data:` URL，因此 `http(s)` 图片会由网关下载并转成 Data URL（按真实字节嗅探 png/jpeg/gif/webp，不信任声明的 MIME）；不支持的格式会让本次优化跳过并降级。
4. 调用优化接口 `POST {base_url}/v1/chat/completions`，`Authorization: Bearer <密钥>`，`model` 为优化模型名，`messages` 里带一段系统提示词和「提示词 + 图片」的用户消息。
5. 取回结果后清洗成提示词正文：优先取 JSON 里的 `prompt`/`optimized_prompt`/`rewritten_prompt`/`text`；否则按纯文本处理，去掉 `<!-- ... -->` 元信息、markdown 代码围栏和开头的中文标题行。
6. 把清洗后的正文写回原 `textPath`，替换后的请求体再按 `req_mapping` 映射并发给上游。
7. 异步视频任务会把 `original_prompt`、`optimized_prompt`、`prompt_optimizer_meta` 快照写进 `async_tasks`，便于对账。

**优化失败不阻断生成**：超时、网络错误、4xx/5xx、返回内容不可解析等情况一律降级为「使用用户原始提示词」继续请求上游，只在日志中记录原因；响应体里的 `prompt_optimizer.reason` 也会带上原因，便于排查。

### 9.2 logical_models 配置字段

- `optimize_prompt`：`1` 开启该模型的提示词优化，`0` 关闭。
- `optimizer_base_url`：优化服务地址，可填 `https://api.mmg.lat`，也可直接填完整的 `/v1/chat/completions`。
- `optimizer_api_key`：优化服务密钥。为空时回退到环境变量 `OPTIMIZER_API_KEY`。
- `optimizer_model`：优化服务上的模型名，默认 `h3-prompt-writing`。
- `optimizer_system_prompt`：覆盖内置的系统提示词，留空使用内置的视频提示词改写指令。
- `optimizer_json_mode`：`1` 在用户消息末尾附加「请返回 json 格式。」以获得结构化结果，`0` 按纯文本处理。
- `optimizer_timeout_ms`：超时时间，默认 `120000`。实测纯文本约 12–22 秒，带图约 15–35 秒，不建议低于 60000。
- `optimizer_send_media`：发给优化服务的媒体类型，逗号分隔，可选 `image`、`video`、`audio`，默认 `image`。
- `optimizer_allow_http`：`1` 允许 http 明文优化地址。出于密钥安全默认 `0`；优化地址是 http 且未开启时，网关会跳过优化并在日志中说明。
- `optimizer_debug`：`1` 时在同步响应里返回 `prompt_optimizer` 字段（是否优化成功、耗时、模式、镜头数等）；失败降级时无论该开关如何都会返回。

后台「提示词优化」页可保存优化服务的全局默认值（存在 `gateway_settings` 表的 `prompt_optimizer_defaults`），
每个逻辑模型只需打开开关即可沿用；模型里留空的地址/密钥/模型名会回退到全局默认值。
其中 `optimizer_concurrency`（默认 500，上限 500，默认不排队）和 `optimizer_queue_wait_ms`（默认 300000）是全局专属项，只在这一页配置。
「测试连接」按钮用一条很短的文本请求做连通性检查，不会创建上游任务。

### 9.3 并发、重试与超时

优化服务对单个账号有并发上限，突发请求过多时会返回类似
`HTTP 502 ... Concurrency limit exceeded for account, please retry later` 的错误。网关做三层处理：

1. **排队限流**：网关自身限制同时发往优化服务的请求数，默认 **500**（上限 500），即默认不做并发限制、不排队。
   可在后台「提示词优化」页调低：一旦调低，超出的请求会排队等待，不再直接撞服务端上限。
2. **排队等待上限**：排队超过 `optimizer_queue_wait_ms`（默认 **300000**，即 5 分钟）仍未获得执行机会才会降级。
   只有把并发调低后这一项才会真正起作用。
   这个值要结合单次延迟和突发规模设置：并发数越小、单次越慢，突发时后面的请求排队越久，
   上限太小就会出现"排了很久最后还是没用上优化"的情况。优化极慢（单次可达 200 秒以上）时应适当调大。
3. **限流重试**：识别到并发/限流类错误（`concurrency limit`、`too many requests`、`rate limit`、`并发`、`限流` 等）时，
   最多重试 3 次，间隔 2 秒、6 秒。其他 4xx/5xx 不重试，直接降级。
4. **自动降级**：仍失败就用用户原始提示词继续请求上游，响应里的 `prompt_optimizer.reason` 会说明原因。

失败响应的 `prompt_optimizer` 还会带 `attempts`（实际请求次数）和 `queue_wait_ms`（排队耗时），便于判断是排队还是服务端慢。

注意事项：

- 实测单次优化延迟波动较大：13–22 秒（本地）、46–52 秒（服务繁忙）、带图最慢见过约 120 秒，批量排队时观测到 200 秒以上。
  `optimizer_timeout_ms` 默认 120000，不建议调小；这个超时只作用于单次 HTTP 调用，不含排队时间。
- 并发数默认 500，即不做限制、不排队；账号并发额度充足时保持默认即可。
  只有日志里反复出现 `Concurrency limit exceeded` 时才需要调低，调低后才会开始排队。
- 每个模型也可以单独关闭优化；优化失败不影响视频生成，只是这次没有优化。

### 9.4 注意事项

- 提示词优化是同步调用，会给每个开启该功能的请求增加一次优化耗时；它只影响延迟，不额外计入网关额度。
- 优化后的提示词是给视频/图片模型用的，会原样替换下游放在 `prompt`（或 user 消息）里的内容；不要让同一次请求既依赖原始提示词做别的事情。
- 优化服务通常会把结果包一层 markdown 标题或代码围栏，网关已自动清洗；若上游模型对格式敏感，建议保持 `optimizer_json_mode = 1`。
- 图片必须是真实可解码的图片数据；1×1 之类的占位图可能被优化服务的上游模型拒绝，此时会自动降级并保留原提示词。
- 修改优化配置只影响之后的请求，不会改变已经提交的异步任务。
- 优化服务地址务必使用 https，除非是内网自建服务；http 地址需要显式打开 `optimizer_allow_http`，密钥会明文传输。

## 10. 容易出错的点

- 不要把下游模板字段改成上游字段。应该在 `req_mapping` 中翻译。
- 不要忘记异步提交响应的 `task_id`，否则网关无法保存上游任务号。
- 不要忘记轮询完成响应的 `video_url`，否则 `/content` 无法拿到视频地址。
- 不要把上游 `in_progress` 原样返回给下游模板，建议归一为 `processing`。
- 轮询返回的 `created_at` 必须是 Unix 秒级时间戳（例如 `1789191547`）。上游返回 ISO 时间或毫秒时间时，在 `poll_mapping` 中转换为秒；缺失时可使用当前时间戳。
- 不要映射上游不支持的媒体字段。
- 不要把上游文档里的示例 URL、示例 key、示例 prompt 当成生产配置。
- 如果下游使用网关自有 key，必须在渠道或绑定中配置上游 key，否则上游请求可能没有有效鉴权。

## 11. 非 Bearer 渠道与已配置渠道示例

渠道的 `auth_type` 默认为 `bearer`，也可在后台选择 `x-auth-token`。
后者把选中的上游密钥发送为 `X-Auth-Token: <key>`；密钥优先级不变。
提交、轮询和开启代理时的同源视频内容请求均使用该方式。新任务保存
`upstream_auth_type_snapshot`，旧任务无快照时继续使用 Bearer。
修改已有渠道鉴权方式不会改变已提交任务。

### 11.1 Vylai MiniMax H3

Vylai MiniMax H3 使用 `https://queueapi.vylai.com`，鉴权为 `x-auth-token`。
三个模板及可复用的映射位于 `scripts/vylai-minimax-config.js`。
`prompt` 映射为 `extra_data.text`，`seconds` 映射为 `config_values.duration`，
`aspect_ratio` 映射为 `config_values.aspect`；图片与音频分别使用 `image_path`、`audio_path`。
Fast 模板必须提供图片且不支持音频，所有模板都不映射视频输入。
未提供 resolution 时省略该配置，使用上游模板默认值。
创建响应使用 `data.task_id`，完成结果使用 `data.result_oss_url`，按结果直链返回。
同一渠道下的 SD 2.0 Fast 模板（`75api-sd20-fast-20260919`）见 11.7 节：它复用这里导出的
`buildPollMapping`，创建请求的 `config_values` 形状不同。

轮询映射（`buildPollMapping`）除了归一状态，还负责把上游异常落成终态，规则如下：

- 只要响应里出现 `error_message`、`error` 或 `display_error_message`，无论上游 `status` 是否已经
  翻到 `failed`（实测可能仍是 `pending` / `preparing` / `running`），都输出下面的失败形状。
- 失败形状固定为下游要求的格式（`id` / `task_id` 由 `server.js` 轮询后覆盖成网关任务号）：

```json
{
  "id": "gw_task_id",
  "task_id": "gw_task_id",
  "object": "video.generation",
  "model": "75api-minimax-h3-audio-20260911",
  "status": "failed",
  "progress": 100,
  "created_at": 1789820187,
  "completed_at": 1789820192,
  "error": {
    "message": "参考图下载失败: Client error '420 ' for url 'https://img.alicdn.com/...jpg'",
    "code": "reference_image_download_failed"
  }
}
```

- 失败时不输出 `video_url`；`progress` 固定 `100`；`completed_at` 取上游 `updated_at`（缺失或不可解析时
  取当前时间）。
- `error.message` 格式化：去掉 `[pod 名]` 前缀，把换行和连续空白压成单个空格，去掉尾部
  `For more information check: ...` 链接，并把上游用词「下载图像失败」统一成「参考图下载失败」；
  只有 `display_error_*` 时直接用它的描述正文（不再拼错误码前缀）；`error` 是对象时取其中的
  `message` / `msg` / `code`；完全没有错误文本时输出 `上游任务失败: <status>` / `上游未返回任务状态`。
- `error.code` 按语义归类：`reference_image_download_failed`（参考图/图片下载失败）、
  `gpu_out_of_memory`（显存不足）、`content_moderation`（上游 `display_error_code` 为
  `CONTENT_MODERATION`）、`video_generation_cancelled`（上游取消），其余回落
  `video_generation_failed`。
- 响应没有 `data` 包装、完全没有 `status`，或返回 `{ code: 500, msg: ... }` 这类错误体时，同样输出
  这个失败形状。旧映射在这种情况下会输出一个不带 `status` 的对象，下游只能一直轮询，
  表现就是任务永远停在“进行中/未启动”。
- 完成时保持原来的形状（`status: "completed"`、`progress: 100`、`object` 与 `video_url` 都是结果直链、
  `error: null`，并带 `completed_at`）；进行中输出 `queued` / `processing` 且 `error: null`。
- 只有上游明确给出成功状态（`completed` 等）时才输出 `completed`；无法识别的状态归一为 `processing`，
  继续轮询而不是把原始状态透传给下游。
文档未提供真实 Key，首次配置后需要在后台填写渠道默认密钥，或通过下游 Bearer Key 透传上游 Key。

在运行中的网关容器内执行配置脚本，以复用其实际数据库连接；脚本要求显式设置
`EXPECTED_DB_HOST` 和 `EXPECTED_DB_NAME` 并核对连接，匹配已有记录时不会重复添加。
配置脚本只创建渠道和模型，不发起付费生成请求。

### 11.2 佳速 Seedance（seedance-2.0-900 / seedance-2.0-933 / seedance-2.5-101010）

上游为佳速 `https://ai.jiasuapi.com/v1`，Bearer 鉴权，OpenAI 风格视频协议。

- 提交：`POST /video/generations`；轮询：`GET /videos/tasks/{task_id}`。
- 上游模型名分别为 `seedance-2.0-900`、`seedance-2.0-933`、`seedance-2.5-101010`，
  三个逻辑模型名与上游真实模型名同名，`req_mapping` 中固定写死。
  上游文档的创建示例里写的是 `seedance-2.5-301010`，但同一篇文档的响应示例是 `seedance-2.5-101010`，
  以前者为准会失败；这里按响应示例与 `GET /v1/models` 的结果使用 `seedance-2.5-101010`。
- `seconds` 映射 `duration`；客户端未传 `duration` 时上游按模型 API 参数的默认值执行并按秒计费，
  因此映射只在 `seconds` 存在时才写入 `duration`。
- `aspect_ratio` 映射上游的 `ratio`，未传时默认 `16:9`；`resolution` 未传时默认 `720p`。
- 参考素材格式为 URL 或 `{url, name?, type?}`，`name` 可在 `prompt` 中用 `@名称` 引用，
  网关按原样透传，不做改写。图片 `type` 可选 `first_frame` / `end_frame`。
- `seedance-2.0-900` 只支持参考图 `images`，绑定不映射 `videos` 与 `audios`；
  `seedance-2.0-933` 和 `seedance-2.5-101010` 额外支持参考视频 `videos` 与参考音频 `audios`。
- 提交响应使用顶层 `id`（同时兼容 `task_id`）作为上游任务号；状态枚举为
  `queued` / `in_progress` / `completed` / `failed` / `unknown`，
  映射时把 `in_progress` 归一为 `processing`、`unknown` 归一为 `queued`。
- 完成结果为 `result_urls` 数组，`poll_mapping` 取首项映射为 `video_url` 与 `object`，同时保留 `result_url`。
- 结果链接是 `m.jiasuapi.com` 公开 CDN 直链，因此绑定保持“返回直链”，`proxy_content = 0`。
- 素材上传接口（`/v1/uploads` 一类）是上游免费工具，本网关不封装；需要 `name` 引用时，
  下游可直接把上游可访问的 URL 传入 `images` / `videos` / `audios`。

模板与可复用的映射位于 `scripts/jiasu-seedance-config.js`，
配置脚本为 `scripts/add-jiasu-seedance.js`，用法与 11.1 相同。
脚本只在本地库执行时同样要求显式设置 `EXPECTED_DB_HOST` 和 `EXPECTED_DB_NAME`，
核对连接后才会写入；重复执行不会重复添加。
上游文档未提供真实 Key，渠道以 `api_key = NULL` 创建，
首次配置后需要在后台填写渠道默认密钥，或通过下游 Bearer Key 透传上游 Key。
映射表达式可用 `node --test test/jiasu-seedance.test.js` 校验，不需要发起付费生成请求。

### 11.3 MCNIO GPT Image 2.5 Sunburst / Flare（gpt-image-2.5-2k / gpt-image-2.5-4k）

上游复用已存在的渠道 `MCNIO GPT Image`（`https://api.mcnio.com`，Bearer），
统一入口 `POST /v1/chat/completions`，同步返回，不走轮询。

上游是「固定规格模型名」平台：分辨率和比例都写在模型名里，形如
`gpt-image-2.5-sunburst-{分辨率}-{比例}` 与 `gpt-image-2.5-flare-{分辨率}-{比例}`，
分辨率 `1k` / `2k` / `4k`，比例 `1x1` / `16x9` / `9x16` / `21x9` / `4x3` / `3x2` / `3x4` / `2x3` / `5x4` / `4x5`。
上游文档要求「渠道只配 60 个固定规格名，不要只配短名」，并明确请求里不要传 `quality`（会返回 400，
默认质量 `medium`），也不要传 `duration`、`aspect_ratio`、`resolution`、`size`、`width`、`height`。

本网关没有把 60 个固定规格名全部暴露给下游，只按分辨率分档暴露两个逻辑模型，比例由下游传：

- `gpt-image-2.5-2k`：下游只传 `model` 和 `size`（比例，`16:9` 或 `16x9` 都接受，缺省 `1x1`），
  `req_mapping` 拼成上游 `gpt-image-2.5-sunburst-2k-{比例}`。
- `gpt-image-2.5-4k`：同上，拼成 `gpt-image-2.5-sunburst-4k-{比例}`。
- 默认变体是 Sunburst；需要 Flare 时下游额外传 `variant: "flare"`，
  或直接把完整上游模型名放进 `model`（例如 `gpt-image-2.5-flare-2k-16x9`），网关会按原名透传。
- 未接入 `1k` 档（上游 1K 名仍然存在，按需再加一条逻辑模型即可，映射生成函数按档位参数化）。
- 本节是 **GPT Image 2.5** 产品线（`gpt-image-2.5-sunburst-…` / `gpt-image-2.5-flare-…`）。
  同一个 `MCNIO GPT Image` 渠道上还有一条命名不同的独立产品线 **GPT Image2**
  （`gpt-image2-1k-16x9` 这种形态：没有点号、没有 sunburst/flare 变体，档位 1k / 2k / 4k），
  它的 1K 档见 11.9 节，两边的映射不能互相套用。
- 白名单外的比例会归一成 `:`/`/` 换成 `x` 的形式交给上游判断，不做二次校验。

图生图直接把 `images` 展开进消息：文字提示词作为 `messages[0].content` 的第一个 `text` 段，
每张参考图各占一个独立的 `image_url` 段（上游支持 1~6 张，URL / data URL / base64 均可）。
没有有效参考图时 `content` 退化为纯文本，走文生图。

上游把结果放在 `choices[0].message.content`，常见形式是 Markdown 图片
`![Generated Image](https://img.mcnio.com/generated/xxx.png)`；
`resp_mapping` 把它归一到顶层 `url`（同时保留 `data[0].url`），
data URL 结果额外给出 `b64_json`。上游若按 OpenAI 图像接口返回 `data[0].url` 也兼容。

模板与映射位于 `scripts/mcnio-gpt-image-25-config.js`，配置脚本为 `scripts/add-mcnio-gpt-image-25.js`：
脚本默认 `--dry-run` 只打印将写入的内容，`--apply` 才写入；要求显式设置
`EXPECTED_DB_HOST` 和 `EXPECTED_DB_NAME` 并核对连接，复用已有渠道，重复执行不会重复添加。
映射可用 `node --test test/mcnio-gpt-image-25.test.js` 校验，不需要发起付费生成请求。

本仓库的 JSONata 是 2.2.2，写映射时注意两点：没有 `$isObject` / `$isArray`（用 `$type(x) = "object"` /
`$type(x) = "array"` 判断），传给 `$filter` / `$map` 的匿名函数体只能是单个表达式，不能在里面写
`$v := ...;` 形式的赋值语句。表达式里也不能写 `//` 注释（解析器会把 `/` 当运算符），说明写在 JS 注释里。

### 11.4 klong.lat GPT Image 2（gpt-image-2 第二渠道）

上游 `https://api.klong.lat`，Bearer 鉴权，OpenAI 兼容。上游真实模型名就是 `gpt-image-2`，
`GET /v1/models` 声明它支持 `openai`、`image-generation`、`image-edits` 三种入口。

本渠道不新增逻辑模型，而是复用既有 `gpt-image-2`，作为渠道「gpt图片生成」
（`http://154.9.235.100:3006`）之外的第二条绑定：两个渠道共用**完全相同**的
`req_mapping` / `resp_mapping`，只有 `base_url` 与密钥不同，下游看到的请求与返回格式不变，
多绑定之间按 `weight` 随机路由。两条映射由 `scripts/sync-gpt-image-2-mapping.js`
统一同步，改一处即可让两个渠道同时生效。

#### 下游支持的两种请求形态

映射同时兼容下面两种形态，下游不必改写：

**形态 1：网关统一模板**（`POST /v1/images/generations` 或 `/v1/images/edits`）

```json
{
  "model": "gpt-image-2",
  "prompt": "一只在月光下的猫，插画风格",
  "size": "16:9",
  "quality": "high",
  "n": 1,
  "response_format": "url",
  "images": ["data:image/png;base64,..."]
}
```

**形态 2：OpenAI 原生 `POST /v1/chat/completions`**

```json
{
  "model": "gpt-image-2",
  "response_format": {"type": "url"},
  "size": "1792x1024",
  "quality": "high",
  "n": 1,
  "messages": [{"role": "user", "content": "生成一张城市夜景"}]
}
```

图生图时 `messages[0].content` 换成数组，参考图放在 `image_url` 段：

```json
{
  "model": "gpt-image-2",
  "size": "1792x1024",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "参考这几张图片融合成城市夜景"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
    ]
  }]
}
```

映射规则：

- 提示词来源优先级：顶层 `prompt` > `messages[0].content`（字符串）>
  `content` 数组里 `type=text` 的段（多段用空格拼接，空白段忽略）> 顶层 `text`。
- 参考图来源：顶层 `images` 与 `content` 数组里的 `image_url.url` **合并**；
  元素可以是 URL/data URL 字符串，也可以是 `{ "url": ... }` 对象；空值被过滤。
- 无参考图 → 上游 `POST /v1/chat/completions`（提示词进 `messages[0].content`）。
- 有参考图 → 上游 `POST /v1/images/edits` multipart，`image` 字段可重复；
  该分支**不会**把 `messages` 带给上游（上游 edits 接口不接受 `messages`）。
- `size` 支持画幅 `16:9` / `9:16` / `1:1` / `4:3` / `3:4`，换算成
  `1792x1024` / `1024x1792` / `1024x1024` / `1536x1152` / `1152x1536`；
  其他值（如 `1792x1024` 本身）原样透传，缺省 `1024x1024`。
- `quality` 缺省 `high`，`n` 缺省 `1`。**下游不带 `quality`、传空串/空白、或传 `null`
  时，网关都会强制补成 `"high"`**，不会把 `null` 或空值透传给上游。
- `response_format` 下游传字符串 `"url"` 或对象 `{"type":"url"}` **都可以**，
  网关统一归一成上游要求的**字符串**；缺省 `url`（`null` / 空对象也回落 `url`）。
- 返回归一到顶层 `url`：兼容 OpenAI 风格 `data[0].url` 与 chat/completions 的
  Markdown 图片 `choices[0].message.content`。

注意：网关只解析 JSON 请求体（`express.json`），**不接受下游直接发 multipart**。
下游如果自己拼 `multipart/form-data` 打 `/v1/images/edits`，`req.body` 为空、
`req.body.model` 为 `undefined`，网关会在选绑定时抛
`Bind parameters must not contain undefined` 并返回 500。参考图请走 JSON 里的
`images` 数组或 `image_url` 段。

实测要点（2026-10）：

- 上游把 `response_format.type` 声明成 **string**。传统写法传 `{"type":"url"}` 会被上游
  400 拒绝：`json: cannot unmarshal object into Go struct field ResponseFormat.response_format.type of type string`。
  这就是本渠道必须把对象归一成字符串的原因；`/v1/images/generations`、`/v1/chat/completions`、
  `/v1/images/edits` 三个上游入口都要求字符串。
- 写这个映射时踩到两个 JSONata 2.2.2 的坑，改映射时注意：
  1. 表达式里**不能写 `//` 注释**（会被当成正则起始符，抛
     `Empty regular expressions are not allowed`），说明只能写在模板字符串外面；
  2. `and` / `or` **不会短路**，`$type(x) = "string" and $trim(x) != ""` 里即使
     `$type(x)` 不是字符串，`$trim(x)` 也会被求值并对 null 抛错。
     缺省值判断要用嵌套三元（先判类型再判内容），别用 `and` 串联。
- chat/completions 与 images/edits 都可能直接返回 `data:image/...;base64,...` 的 data URL，
  此时顶层 `url` 就是该 data URL，下游按 URL 或 base64 处理都可以。
- 参考图必须是真实可解码的图片，否则上游返回
  `{"detail":"We couldn't process this image. Error code: image_parse_error."}`（HTTP 400）；
  1×1 占位图也会被拒。
- 上游 `/v1/images/edits` 只接受 HTTPS 参考图 URL 或 data URL / base64；
  网关 multipart 构造对 `http://` 参考图会直接报错。

模板与映射位于 `scripts/klong-gpt-image-2-config.js`，配置脚本为
`scripts/add-klong-gpt-image-2.js`（`--dry-run` 预览 / `--apply` 写入，要求显式设置
`EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME`，复用既有渠道与逻辑模型，重复执行不重复添加；
渠道已有密钥时不覆盖）。渠道默认密钥写在配置文件里，可用环境变量 `KLONG_API_KEY` 覆盖。
映射改动后用 `scripts/sync-gpt-image-2-mapping.js --dry-run` / `--apply` 同步到
「gpt图片生成」、「gpt图片生成 Klong」与「gpt图片生成 688」三个绑定
（688 只同步 `req_mapping`，它有自己的扩展 `resp_mapping`，见 11.6 节）。
脚本用 `legacy_req_mappings`
（配置文件里记录的历史版本名单）判断绑定是否「同源」，**每次改完 `req_mapping`
必须把被替换掉的版本追加进 `legacy_req_mappings`**，否则下一次同步会因为对不上而跳过；
脚本不会修改 `status` 与 `weight`，也不会重新启用已停用的绑定。
映射可用 `node --test test/klong-gpt-image-2.test.js` 校验，不需要发起付费生成请求；
端到端可用 `node tools/verify-klong-formats.js <网关地址> <网关密钥>` 跑四种形态。

#### 部署注意：网关容器必须能校验证书

HTTPS 渠道依赖容器内的 CA 证书库。本仓库 `Dockerfile` 使用
`FROM node:20-bookworm-slim`，该镜像**不含 `ca-certificates`**，
表现为容器内 `/etc/ssl/certs` 不存在、所有 HTTPS 上游报
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`（`unable to verify the first certificate`）。
此时网关上任何 `https://` 渠道都会失败，而 `http://` 渠道正常。
自建镜像请在 `Dockerfile` 里补上：
`RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*`。

#### 第四渠道 gpt-image-duolapi（#40）：文生图改走 `/v1/images/generations`

逻辑模型 `gpt-image-2` 上还有一条独立渠道绑定：渠道 `gpt-image-duolapi`
（`https://api2.duolapi.cn`，Bearer，new-api 系网关——响应头带
`X-New-Api-Version` / `X-Oneapi-Request-Id`），绑定位于渠道 #40，上游模型名固定
`gpt-image-fast`。当前它是 `gpt-image-2` 唯一启用的绑定（其它渠道的绑定都是停用状态），
所以 `gpt-image-2` 的流量全部走它。

两个入口按「有没有参考图」在 `req_mapping` 里用 `_route_path` 切换：

| 场景 | 上游路径 | 报文 |
|---|---|---|
| 文生图（无参考图） | `POST /v1/images/generations` | JSON：`model` / `prompt` / `size` / `quality` / `n` / `response_format`（**字符串** `url` 或 `b64_json`） |
| 图生图（有参考图） | `POST /v1/images/edits` | multipart/form-data：字段同上（`response_format` 也是字符串），参考图为可重复的 `image` 文件部分 |

变更历史：文生图分支**原来走 `POST /v1/chat/completions` + `messages`**（`response_format`
是 `{"type":"url"}` 对象），2026-10 按需求改为 OpenAI 标准图片接口
`/v1/images/generations` + `prompt`；图生图分支保持不变。旧版本已登记在配置文件的
`legacy_req_mappings` / `legacy_resp_mappings` 里，便于识别历史绑定。

其它规则与 Klong / 688 一致：`size` 画幅换算（`16:9`→`1792x1024`、`9:16`→`1024x1792`、
`1:1`→`1024x1024`、`4:3`→`1536x1152`、`3:4`→`1152x1536`，其它值原样透传、缺省
`1024x1024`），`quality` 缺省 `high`，`n` 缺省 `1`，提示词优先级 `prompt` >
`messages[0].content`（字符串）> `content` 里 `type=text` 的段 > `text`；
图生图的文件部分由网关按 `files[].source` 下载后上传（`https` 直链会被网关重新取回再作为
文件上传，`data:image/...` 先经渠道开关 `convert_base64_to_url=1` 换成图床链接），
`filename` 固定 `image-1` / `image-2`…，part 的 content-type 取下载时的真实类型。

响应侧：优先取 `data[0].url`；上游只回 `data[0].b64_json` 时映射成 data URL，再由渠道开关
`convert_resp_base64_to_url=1` 换成图床 HTTPS 链接返回下游（上游本来就给链接时不做改动）；
仍兼容 chat 分支的 Markdown 图片 `![alt](url)`；空响应 / 错误体不会凭空造链接。

模板与映射位于 `scripts/duolapi-gpt-image-2-config.js`，写入脚本为
`scripts/update-duolapi-gpt-image-2.js`（`--dry-run` 预览 / `--apply` 写入；
默认只更新「当前映射是本渠道登记过的版本」的绑定，手改过的映射需要显式 `--force`；
渠道按 `name` / `base_url`、绑定按（逻辑模型，渠道）唯一定位，重复执行只更新差异字段，
不动 status / weight / 密钥）。映射可用 `node --test test/duolapi-gpt-image-2.test.js`
校验（8 项：两个分支的路由与报文形状、画幅换算与缺省值、messages 形态取词、
参考图来源与文件命名、响应归一），不需要发起付费生成请求。

注意：本绑定的映射与 Klong / 688 **不是同一份**（上游模型名不同），
`scripts/sync-gpt-image-2-mapping.js` 默认按「逐字同源」判定，不会覆盖本绑定；
只有显式加 `--all-bindings` 才会被覆盖，改动本渠道映射后需要重新执行本渠道的写入脚本。

本次改动**没有做真实出图验证**：改完后用渠道密钥探测上游时返回
`{"error":{"message":"Concurrency limit exceeded for user...","code":"gateway_concurrency_limit"}}`
（该 key 当时有并发任务），因此报文形状来自映射求值与上游文档，未实际出图。

#### 第五渠道 gpt-image-ad（#41，stars739.top）

新增渠道 `gpt-image-ad`（`https://stars739.top`，Bearer），作为逻辑模型 `gpt-image-2`
的另一条绑定（渠道 #41，绑定 #273，同步图片流程：`is_async=0`、`proxy_content=0`、
`error_passthrough=1`）。上游模型名与逻辑模型名同名，`req_mapping` 里固定写死 `gpt-image-2`。
该 Key 的 `GET /v1/models`（已实查，只读不计费）返回
`gpt-image-2` / `gpt-image-2.5` / `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`，
本次只接 `gpt-image-2`，其余三个需要时按同样方式再加逻辑模型。

两个入口由 `req_mapping` 按「有没有参考图」用 `_route_path` 切换：

| 场景 | 上游路径 | 报文 |
|---|---|---|
| 文生图（无参考图） | `POST /v1/images/generations` | JSON：`model` / `prompt` / `size` / `quality` / `n` / `response_format`（字符串） |
| 图生图（有参考图） | `POST /v1/images/edits` | multipart/form-data：字段同上，参考图为可重复的 `image` 文件 |

字段规则与 11.4 其它 gpt-image-2 渠道一致（`size` 画幅换算 `16:9`→`1792x1024`、
`9:16`→`1024x1792`、`1:1`→`1024x1024`、`4:3`→`1536x1152`、`3:4`→`1152x1536`，其它值
原样透传、缺省 `1024x1024`；`quality` 缺省 `high`；`n` 缺省 `1`；`response_format`
对象/空值都归一成字符串、缺省 `url`；下游「统一模板」与「OpenAI messages」两种形态都支持，
参考图可来自顶层 `images` 或 `content` 里的 `image_url` 段）。

上游返回（两个入口相同）：

```json
{
  "created": 1792032517,
  "background": "opaque",
  "data": [{ "generation_id": "...", "model": "gpt-image-2", "size": "1774x887", "url": "data:image/png;base64,..." }],
  "output_format": "png",
  "quality": "medium",
  "size": "1774x887",
  "usage": { "input_tokens": 430, "output_tokens": 458, "total_tokens": 888 }
}
```

成图是 **base64 data URL**（放在 `data[0].url`，不是 http 链接），所以渠道开关
`convert_resp_base64_to_url = 1`：网关在响应映射之后把它上传图床、换成 HTTPS 链接再返回下游
（下游拿到的顶层 `url` 始终是 http 链接）。请求侧 `convert_base64_to_url = 0`：
multipart 分支的 data URL 参考图由网关自己的 multipart 构造直接解码上传，不必先过图床。
`resp_mapping` 同时兼容只回 `data[0].b64_json` 的形态与 chat 分支的 Markdown 图片，
空响应 / 错误体不会凭空造链接。

路由提醒：`gpt-image-2` 现在有**两条启用中的绑定**——duolapi（#271）与 gpt-image-ad（#273），
权重都是 1，多绑定按 `weight` **随机**路由（约 50/50）。要让 `gpt-image-2` 固定走某一条，
把另一条绑定停用，或把两条的 `weight` 调成悬殊值即可。

模板与映射位于 `scripts/gpt-image-ad-config.js`，写入脚本为 `scripts/add-gpt-image-ad.js`
（`--dry-run` 预览 / `--apply` 写入，要求显式设置 `EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME`；
渠道按 `name` / `base_url` 复用、逻辑模型按 `model_name` 复用且**不覆盖已有 remark**
（`gpt-image-2` 是多渠道共用模型）、绑定按（逻辑模型，渠道）复用，重复执行只更新差异字段，
不覆盖已有渠道密钥、不删除任何记录）。映射可用 `node --test test/gpt-image-ad.test.js`
校验（8 项：两个分支的路由与报文形状、画幅换算与缺省值、messages 形态取词、
参考图来源与文件命名、响应 data URL 归一），不需要发起付费生成请求。

本次接入**没有发送真实出图请求**：上游报文按用户提供的 curl 与返回样本落地，
连通性与模型名来自 `GET /v1/models`（200）。

### 11.5 snumom 万相 3.0 图生高速（wan3.0-image-prime）

上游复用已有渠道 `Grok Video`（`https://snumom.com`，Bearer），异步视频流程：

- 创建：`POST /v1/videos`；轮询：`GET /v1/videos/{task_id}`；下载：`GET /v1/videos/{task_id}/content`。
- 上游模型名与逻辑模型名同名，`req_mapping` 中固定为 `wan3.0-image-prime`。
- 上游请求是扁平 OpenAI 风格：`model` / `prompt` / `seconds`（兼容 `duration`）/ `size` / `aspect_ratio`
  / `reference_images[{url, role}]` / `reference_audios[{url}]` / `prompt_extend` / `parameters` / `input.media`。

字段映射：

- 下游 `seconds` 映射上游 `seconds`，必须显式给出且在 `[2,30]` 内；缺失、`-1`、`0`、`1`、`31+`
  或非数字一律回落到 **5 秒**（上游禁止 `-1` 智能时长，创建时按秒预扣）。
  上游 `seconds` 字段在 Go 结构体里是 **string**，传数字会被上游拒绝并返回
  `invalid_json` / `cannot unmarshal number into Go struct field .Alias.seconds of type string`，
  因此网关内部用 `$number` 校验区间后再 `$string($round(...))` 发回整数字符串（例如 `"10"`）。
- 下游 `resolution` 映射上游 `size`，取值 `480P` / `720P` / `1080P`；缺失或非法值回落到 **1080P**
  （上游默认也是 1080P，计费按档位：480P $0.15/s、720P $0.18/s、1080P $0.20/s，仅按输出时长）。
- 下游 `aspect_ratio` 透传，缺失时默认 `adaptive`（首帧模式推荐值）。
- 下游 `images` 映射 `reference_images`：字符串项补 `role: reference_image`，
  对象项保留 `url` 与 `role`（`first_frame` / `last_frame`）；最多 10 张，图片不计费。
- 下游 `audios` 映射 `reference_audios`（最多 5 段，不计费）。
- 下游 `videos` **不映射**：`wan3.0-image*` 上游禁止 `reference_videos` 和 video 类型的 `input.media`。
- 顶层 `prompt_extend` 或 `parameters.prompt_extend` 都可用来关闭上游提示词智能改写（默认开启）；
  下游 `input`（百炼原生 `input.media`，用于 `file` / `link` 文档网页参考）原样透传。

上游返回与轮询：

- 创建响应 `id` / `object` / `status`，`resp_mapping` 输出 `task_id`（缺省取 `id`）。
- 轮询状态 `queued` / `not_start` → `queued`，`in_progress` → `processing`，`completed` / `failed` 保持；
  无法识别的状态归一为 `processing`，不会把原始状态透传给下游。
- 成片地址在上游 `metadata.url`（兼容 `video_url` / `result_url` / `url`），映射为 `video_url` 与 `object`；
  失败时输出 `failed` 并带上 `error` / `message`。
- 上游 `progress` 只有 `0` / `30` / `100` 的粗粒度值，生成通常 1~5 分钟，`progress: 30` 不代表卡死，
  轮询间隔建议 10~15 秒。绑定开启了 `poll_throttle`，避免下游高频轮询打爆上游。
- 成片 URL 24 小时后失效，因此绑定开启 `proxy_content`，由网关 `/v1/videos/{task_id}/content` 代理取流。

模板与映射位于 `scripts/snumom-wan3-image-prime-config.js`，配置脚本为
`scripts/add-snumom-wan3-image-prime.js`（`--dry-run` 预览 / `--apply` 写入，要求显式设置
`EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME`，复用已有渠道、重复执行不重复添加，不覆盖渠道已有密钥）。
映射可用 `node --test test/snumom-wan3-image-prime.test.js` 校验，不需要发起付费生成请求。

### 11.6 688 图片渠道 GPT Image 2（gpt图片生成 688）

上游 `https://img.688.qzz.io`，Bearer 鉴权，OpenAI 兼容图片服务。
`GET /v1/models` 返回 `gpt-image-2`、`gpt-image-2.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`，
声明入口 `["image-generation", "openai"]`。

本渠道复用既有逻辑模型 `gpt-image-2`，作为「gpt图片生成」（`http://154.9.235.100:3006`）、
「gpt图片生成 Klong」（`https://api.klong.lat`）之外的另一条绑定：三者共用**完全相同**的
`req_mapping`，下游请求与返回格式不变，多绑定之间按 `weight` 随机路由。

#### 请求形态

与「gpt图片生成」逐字相同，下游两种形态都支持：

- 无参考图 → 上游 `POST /v1/chat/completions`：`model` 固定 `gpt-image-2`，
  `response_format` 是 `{"type":"url"}` 对象，`messages[0].content` 是提示词字符串。
- 有参考图 → 上游 `POST /v1/images/edits` multipart：`image` 字段可重复，
  该分支不发送 `messages`。

`size` 画幅换算、`quality` 缺省 `high`、`n` 缺省 `1`、`response_format` 归一成字符串等规则
与 11.4 节完全一致（同一份映射）。

#### 返回形态与 base64 转链接

`resp_mapping` 在 Klong 那版基础上扩展，把下面这些形态都归一到顶层 `url`（同时保留
`b64_json` 与 `data[0]`）：

- OpenAI 风格 `data[0].url` / `data[0].b64_json`（含 `image.data[0].*`、`image.url`、`image_urls[]`）。
- `choices[0].message.content` 里的 Markdown 图片 `![alt](https://...)`。
- `choices[0].message.content` 直接是 `data:image/...` 或裸 base64。
- `content` 是数组时取其中的文本段。

上游按 base64 返回图片，因此本渠道把渠道开关 `convert_resp_base64_to_url` 设为 `1`：
网关在响应映射之后把 `data:image/...`、裸 base64 与 Markdown 里的 data URL 上传到
图床（Zipline `files.mmg.lat`，见第 5 节「图床」），换成 HTTPS 链接再返回下游。
下游看到的 `url` 永远是 http 链接，与「gpt图片生成」渠道一致；上游返回的本来就是链接时不做改动。

限流时上游会回 HTTP 429 `上游返回频率限制，请稍后重试`，或 200 + `choices[0].message.content`
里的一句「未能生成图片」错误话术。后者**不会**被当成图片：映射只在 content 是 Markdown 图片、
data URL 或整段裸 base64 时才把它填进 `url`，否则 `url` 为空字符串。

#### 响应侧转换的实现要点（server.js）

- `tryConvertResponseImages(responseBody, binding)` 在 `sendMappedPost` 里紧接 `resp_mapping` 之后执行，
  只有 `channels.convert_resp_base64_to_url = 1` 的绑定才会进入递归遍历；开关为 `0` 时行为与以前完全一致。
- 裸 base64 只认图片字段名（`b64_json`/`base64`/`image_base64`/`images`/`image_urls`/`image`/`url`/`data`/`content`）
  且长度 ≥128、字符集为 base64 的字符串，避免把提示词或错误话术上传成图片。
- 图床对所有上传都返回 `.png` 链接；链接本身没带扩展名时，网关按 base64 头部嗅探补上
  `.jpg`/`.gif`/`.webp`/`.png`（`withTruthfulExtension`）。
- 上传失败只记日志并原样返回上游结果，不会把一次成功的生成变成 500。
- Markdown 包装会被剥掉：返回给下游的是裸链接，而不是 `![alt](...)`。

#### 实测与配置

- 2026-10 实测：该密钥在连续调用时会上游限流，四种入口（chat/completions、
  images/generations、images/edits、带/不带 response_format）都返回 HTTP 429，
  限流恢复后重试即可。`tools/probe-688-upstream.js` 用于重新探测真实返回结构。
- 因为上游额度不可用时无法连真实上游验证返回形态，仓库提供本地 mock 上游
  `tools/mock-img688-upstream.js` 与端到端校验脚本 `tools/verify-img688-pipeline.js`
  （会临时建一个指向 mock 的渠道与绑定，跑完删除并恢复其它绑定状态）。
  当前 13 项检查全部通过，覆盖：data URL 文生图、带参考图的 images/edits multipart、
  Markdown 里的 data URL、http 链接原样返回、限流错误话术不产生假链接、返回体不含 base64、
  以及图床链接可下载。
- 模板与映射位于 `scripts/img688-gpt-image-2-config.js`，配置脚本为
  `scripts/add-img688-gpt-image-2.js`（`--dry-run` 预览 / `--apply` 写入，要求显式设置
  `EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME`，复用既有渠道与逻辑模型，重复执行不重复添加；
  渠道已有密钥时不覆盖）。渠道默认密钥写在配置文件里，可用环境变量 `IMG688_API_KEY` 覆盖。
- 映射可用 `node --test test/img688-gpt-image-2.test.js` 校验，不需要发起付费生成请求。
- `scripts/sync-gpt-image-2-mapping.js` 会把 Klong 的 `req_mapping` 同步到 688 绑定上，
  但**不会**把 688 的 `resp_mapping` 覆盖成 Klong 那版；改动 Klong 的 `req_mapping` 时，
  如果 688 的历史版本需要登记，追加到 `img688-gpt-image-2-config.js` 的 `legacy_req_mappings`。

### 11.7 Vylai SD 2.0 Fast（75api-sd20-fast-20260919 / seedance-2.0-933-480p / seedance-2.0-933-720p）

复用 11.1 的既有渠道 `Vylai MiniMax H3`（`https://queueapi.vylai.com`，`x-auth-token`），
不新建渠道：同一个 Key 同时覆盖 `75api-minimax-h3-*` 与 `75api-sd20-fast-20260919` 两类模板。
上游文档是「SD 2.0 Fast / Wan 3.0 视频生成 OpenAPI 调用说明」，本文只接入 SD 2.0 Fast 模板。

同一上游模板下暴露三个逻辑模型，区别只在 `config_values.resolution` 的来源：

| 逻辑模型名 | resolution 来源 | 说明 |
|---|---|---|
| `75api-sd20-fast-20260919` | 下游传 `resolution` | 通用入口；支持 `480p` / `720p`，非法值回落 `480p` |
| `seedance-2.0-933-480p` | 由模型名写死 `480p` | 下游传任何 `resolution` 都被忽略 |
| `seedance-2.0-933-720p` | 由模型名写死 `720p` | 下游传任何 `resolution` 都被忽略 |

下游需要按模型名区分分辨率时用后两个（例如插件只按模型名选档，不解析额外参数）；
两档之外不需要新模型，加一条 `NAMED_MODELS` 记录即可（`scripts/vylai-sd20-fast-config.js`）。
三个模型共用同一份创建路径、轮询路径与轮询映射，`resp_mapping` / `poll_mapping` 里的
`model` 字段各自写自己的逻辑模型名。

- 创建：`POST /openapi/tasks/create`；轮询：`GET /openapi/tasks/{task_id}`（与 11.1 相同）。
- 上游模板名 `75api-sd20-fast-20260919` 在 `req_mapping` 里固定写死，三个模型完全相同。
- 创建成功要求 HTTP 200 且 `data.task_id` 非空（`resp_mapping` 只取 `data.task_id`，取不到时
  网关返回 502，不会凭空造任务号）。
- 状态 `pending` / `preparing` / `running` 归一为 `queued` / `processing`，
  `completed` / `failed` / `canceled` 分别归一为 `completed` / `failed` / `failed`；
  完成结果取 `data.result_oss_url`，实测可能是 `oss.vylai.com` 也可能是 `vod.villai.cn`，
  都是无需鉴权的公开直链，因此绑定保持「返回直链」（`proxy_content = 0`）。
- 轮询映射直接复用 11.1 的 `buildPollMapping`（由 `scripts/vylai-minimax-config.js` 导出），
  所以「上游出错字段不固定」「响应没有 `data` 包装」「错误状态仍停在 running」等兜底规则与
  MiniMax H3 完全一致。

字段映射（与 11.1 的差异都在创建请求里）：

| 下游字段 | 上游字段 | 说明 |
|---|---|---|
| `prompt` | `extra_data.text` | 必填 |
| `seconds` | `config_values.duration` | 4–15 的整数秒，默认 `5`；小数先四舍五入，越界回落 `5` |
| `resolution` | `config_values.resolution` | 只有 `480p` / `720p`（**小写 p**）；通用模型非法值回落 `480p`，带分辨率的模型由模型名写死 |
| `aspect_ratio` | `config_values.ratio` | 只有 `9:16` / `16:9`，非法值回落 `9:16` |
| `images` | `image_path` | 最多 9 张，`$count(images) > 0` 时才下发 |
| `audios` | `audio_path` | 最多 3 个，未传不下发 |
| `videos` | `video_path` | 最多 3 个，用途随 `mode` 变化，未传不下发 |
| `mode`（下游扩展字段） | `config_values.mode` | 默认 `reference`（多模态参考生）；可选 `t2v` / `first_frame` / `first_last`，非法值回落 `reference` |
| — | `config_values.watermark` | 固定 `false` |
| — | `config_values.generate_audio` | 固定 `true` |
| — | `priority` | 固定 `0` |

注意点：

- SD 2.0 Fast 用的是 `config_values.ratio` 与 `resolution: "480p"/"720p"`，
  而 11.1 的 MiniMax H3 用 `config_values.aspect` 且不声明 `mode`，两者不能共用一份 `req_mapping`。
- `config_values` 只允许模板已声明的字段，传未知字段上游直接返回 400「未知配置字段」，
  因此 `req_mapping` 只输出上表字段；`watermark` / `generate_audio` 这类下游可能顺手传的字段
  会被忽略并强制回落到固定值。
- `mode` 与素材必须匹配：`t2v` / `first_frame` / `first_last` 不允许参考音频或参考视频，
  `first_frame` 至少 1 张图片、`first_last` 至少 2 张图片、`reference` 可组合图片 / 音频 / 视频。
  上游在任务执行阶段才会以 `failed` + `error_message` 报出这类问题，映射会把
  `error_message` / `display_error_message` 归一成终态 `failed`。
- 上游**拒绝 `data:` 内联 Base64**。渠道已开启 `convert_base64_to_url = 1`，网关提交前会把
  请求体里的 `data:image/...;base64,...` 转成图床 HTTPS 链接，所以下游传 base64 图片可用；
  音频与视频没有对应的转换，必须是公网 `http(s)` URL 或上传接口返回的 COS 相对路径。
- 素材也可以先走上游上传接口（`POST /openapi/upload/presign` + 按 `required_headers` PUT），
  本网关不封装这一步；有公网 URL 时直接传 URL 即可。
- 需要参考视频时把上游可访问的视频 URL 放进下游 `videos`（映射为 `video_path`），
  并在 `mode` 上传 `reference`。
- 写映射时踩到的 JSONata 2.2.2 坑：**表达式里不能写 `//` 注释**，否则解析器把 `/` 当成
  正则起始符并抛 `Empty regular expressions are not allowed`（说明只能写在模板字符串外面）。

模板与映射位于 `scripts/vylai-sd20-fast-config.js`（`buildModel` / `buildReqMapping` 生成三个模型，
`NAMED_MODELS` 里登记带分辨率的逻辑模型名；要再加档位只加一条记录即可），
配置脚本为 `scripts/add-vylai-sd20-fast.js`
（`--dry-run` 预览 / `--apply` 写入，要求显式设置 `EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME` 并核对连接；
复用既有渠道，不新建渠道、不覆盖渠道密钥、不删除既有绑定，重复执行只更新差异字段，一次跑完三个模型）。
首次配置后需要在渠道里填写上游密钥，或由下游透传上游 Key。
映射可用 `node --test test/vylai-sd20-fast.test.js` 校验（含「下游传任意 resolution 都不改变写死档位」
的用例），不需要发起付费生成请求。

2026-10 实测：先用本地 mock 上游经真实网关容器跑通全链路（未消耗上游额度）——创建返回网关任务号、
轮询 `queued → processing → completed`、`video_url` 取到 `data.result_oss_url`。mock 收到的那次请求
（下游传 `resolution=720p`、`seconds=8`、两张图）证明字段逐个按上表落地，请求体为
`{"template_key":"75api-sd20-fast-20260919","extra_data":{"text":...},"config_values":{"mode":"reference","duration":8,"resolution":"720p","ratio":"16:9","watermark":false,"generate_audio":true},"priority":0,"image_path":[...]}`，
鉴权头为 `X-Auth-Token`。随后又用真实上游跑了一条最便宜的 `mode=t2v`、`duration=4`、`resolution=480p`
任务验证：该渠道 Key **已被授权调用 SD 2.0 Fast 模板**，创建返回 `data.task_id`（上游任务号 `4121219`），
约 100 秒后状态 `completed`，`video_url` 为
`https://oss.vylai.com/sd/.../4121219_..._1.mp4`，直链 HEAD 返回 `200 video/mp4`（847 KB，无需鉴权，
所以 `proxy_content = 0` 正确），`GET /v1/videos/{id}/content` 返回该直链。
同样的方式对 `seedance-2.0-933-480p` 与 `seedance-2.0-933-720p` 各跑了一条 `mode=t2v`、`duration=4`、
不传 `resolution` 的真实任务，两者都创建成功并走到 `completed`；用 ffprobe 读成品确认档位确实按模型名生效：
480p 档输出 `864x496`（752 KB），720p 档输出 `1280x720`（2.8 MB），成片时长都是约 4.1 秒。
另外实测结果直链的域名并不固定（既有 `oss.vylai.com` 也有 `vod.villai.cn`），两个域名都是无需鉴权的公开
`video/mp4` 直链，因此 `proxy_content = 0`（返回直链）对两个档位都成立。

### 11.8 AI 创作 Seedance 2.0 Fast（Seedance 2.0 Fast）

上游是「AI 创作」站点的 OpenAI 兼容媒体生成 API（文档为站点 `/api-guide` 页面），
新建渠道 `AI 创作`（`http://116.211.150.21:3000`，Bearer 鉴权），异步视频流程：

- 提交：`POST /v1/videos/generations`；轮询：`GET /v1/tasks/{task_id}`；下载：`GET /v1/tasks/{task_id}/download`。
- 上游模型清单由 `GET /v1/models` 给出，当前为 `Seedance 2.0 Fast`、`Seedance Auto`、
  `doubao-video`、`dola-video`（文档正文的模型表已过时，仍写着 `doubao-image` / `dola-image`）。
  本次只按下游文档接入了 `Seedance 2.0 Fast`，其余三个上游模型没有建逻辑模型，需要时按本节配置方式补即可。
- `wait=false` 时上游返回 HTTP 202 与上游任务号；网关按统一下游模板返回自己的 `gw_task_id`。

字段映射：

| 下游字段 | 上游字段 | 说明 |
|---|---|---|
| `prompt` | `prompt` | 必填，最多 5000 字符 |
| `seconds` | `seconds` | 只支持 `5` / `10` / `15`（统一计费）；缺失、`0`、`-1`、小数、非数字、空串一律回落 **5** |
| `aspect_ratio` | `aspect_ratio` | 透传，文档示例 `16:9` / `9:16` / `1:1` |
| `images` | `image_urls` | 最多 10 张，需上游可访问的公网 URL 或 data URL；为空数组时不下发 |
| — | `wait` | 固定 `false`，网关始终走异步流程 |
| `resolution` | — | 上游没有该字段，被忽略；目前 `Seedance 2.0 Fast` 的画幅由 `aspect_ratio` 决定 |
| `videos` / `audios` | — | 上游不支持参考视频与参考音频，不映射 |

`seconds` 用 `$type` + `/^[0-9]+$/` 先确认可取数，再取 `[5,10,15]` 内值或回落 5。

上游返回与轮询：

- 创建响应（HTTP 202）为 `{task_id, status: "pending", model, object: "video.generation", created, billing} `，
  `resp_mapping` 取 `task_id`（兼容 `id` / `data.task_id`）。
- 轮询 `status` 为 `pending` / `processing` / `completed` / `failed`：`pending` → `queued`，
  其他无法识别的状态归一为 `processing`，不会把原始状态透传给下游。
- 上游 `progress` 是 `"30%"` 这样的**字符串**，映射时去掉 `%` 再转数字；完成时固定 `100`。
- 上游 `created_at` / `completed_at` 是 **ISO 8601 字符串**（`2026-10-07T05:51:55Z`），
  用 `$toMillis(...) / 1000` 转成 Unix 秒；`completed_at` 在非完成态为空串，映射输出 `null`。
- 完成后结果地址的形态**不固定**：有时是站内相对路径（`/v1/tasks/task_xxx/download`），
  有时是第三方 CDN 直链（实测见过 `https://v3-videoweb.doubao.com/...`，带签名与过期参数）。
  第三方直链实测出现过 `403 Forbidden`（网关代理取流因此返回
  `{"error":"Upstream video content request failed","upstream_status":403}`），
  而同一任务的 `{base_url}/v1/tasks/{task_id}/download` 始终返回 `200 video/mp4`。
  因此 `poll_mapping` 在完成态**优先用 poll 响应里的 `task_id` 拼站内下载地址**作为 `video_url`
  （与渠道同源 → 网关代理自动带密钥；CDN 不可用时上游会重新取回），上游给的直链只保留在
  `upstream_result_url` 里供排查。没有 `task_id` 时才退回上游给的地址（相对路径拼 `base_url`，
  绝对地址原样透传）。
- 只要响应里出现非空错误文本（`error`、`display_error_message`），无论 `status` 停在哪个进行中状态，
  都落成终态 `failed` 并带上 `error`；完全没有状态、没有可读错误文本时才输出
  `上游任务失败: <status>`，避免下游一直轮询。
- 结果下载接口 **必须带 Bearer**，无鉴权返回 401，支持 `Range`；因此绑定开启 `proxy_content = 1`，
  由网关 `/v1/videos/{task_id}/content` 代理取流（同源请求会带渠道密钥，Range 透传）。
- 网关侧另有一层兜底：代理取流拿到 401/403 时，会再用 `{base_url}/v1/tasks/{up_task_id}/download`
  重试一次（保留 Range 头），成功则正常返回视频并打日志
  `[Gateway Video Proxy Fallback]`，避免已提交任务因为上游换了直链而永久打不开。

注意点：

- 渠道密钥已写入 `channels.api_key`，可用环境变量 `AICREATION_API_KEY` 覆盖；
  脚本不会覆盖已存在渠道的密钥。
- 上游文档建议 60 秒轮询一次；绑定开启 `poll_throttle`（网关侧最小间隔由
  `POLL_MIN_INTERVAL_SECONDS` 控制，默认 6 秒），下游轮询建议 10~15 秒，别用高频轮询打上游。
- 上游提交接口只认整数秒，传 `7` 会返回 `400 unsupported_model_duration`；
  映射已经把非法值收敛到 5，所以下游传错时长不会失败，只会按 5 秒生成。
- 写映射时再次踩到 JSONata 2.2.2 的坑：`$isFinite` 在这个版本里**不可用**
  （`$isFinite(1)` 抛 `Attempted to invoke a non-function`），`$number("")`、`$number("abc")`、
  `$number(null)` 会抛错且无法用三元兜住。判断「能不能转成数字」必须先用
  `$type(x)` / `$match($string(x), /^[0-9]+$/)` 判断，再调用 `$number`。
  另外 `$toMillis` 对非 ISO 字符串同样会抛错，必须先 `$contains(x, "T")`。

模板与映射位于 `scripts/aicreation-seedance-fast-config.js`，配置脚本为
`scripts/add-aicreation-seedance-fast.js`（`--dry-run` 预览 / `--apply` 写入，要求显式设置
`EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME`；渠道按 `name` / `base_url` 复用，逻辑模型按
`model_name` 复用，重复执行只更新差异字段）。
映射可用 `node --test test/aicreation-seedance-fast.test.js` 校验，不需要发起付费生成请求；
端到端可用 `node tools/verify-aicreation-seedance-fast.js <网关地址> <网关密钥>`（会真实创建一条 5 秒任务）。

2026-10 实测（未走网关，直连上游）：`GET /v1/models` 在带 Bearer 时返回 200，缺头返回 401
`invalid_token`；提交空 `prompt` 返回 400 `prompt_required`、`seconds=7` 返回
400 `unsupported_model_duration`、未知模型返回 404 `model_not_found`，说明文档里的
`/v1/videos/generations` 与 `/v1/tasks/{id}` 就是真实路径（`/v1/videos`、`/v1/video/generations` 都是 404）。
一条 `seconds=5`、`aspect_ratio=16:9` 的真实任务：提交返回 HTTP 202 与 `task_id`，
轮询 `pending → processing → completed`（`progress` 依次 `10%` / `30%` / `100%`，本条约 3 分钟），
完成后 `url` / `urls[0]` / `download_url` 都是 `"/v1/tasks/task_xxx/download"` 相对路径；
该地址 `HEAD` 返回 404、无鉴权 `GET` 返回 401、带 Bearer `GET` 返回 `200 video/mp4`
（251 KB，`accept-ranges: bytes`），带 `Range` 返回 `206`，所以「拼绝对地址 + 网关代理取流」是必需的。

失败态实测：经网关 `POST /v1/videos` 创建的一条 5 秒任务，上游在 `pending`/`processing` 之间来回约 21 分钟后
返回 `status: "failed"`、`progress: "100%"`、`error: "所有可用账号均无法继续生成视频"`、
`error_code: "provider_generation_start_timeout"`，`billing` 为 `refunded`（这属于上游账号池容量不足，
不是映射问题，也不是网关侧失败）。映射把上游错误原样映出后，再由 `server.js` 的
`normalizeVideoError` 归一成下游契约（见第 3 节）：`error` 变成对象，
`provider_generation_start_timeout` 不在语义白名单内所以回落 `video_generation_failed`，
顶层 `error_code` 保留为 `error.code` 的镜像：
`{"status":"failed","progress":100,"video_url":"","object":"video.generation",
"error":{"code":"video_generation_failed","message":"所有可用账号均无法继续生成视频"},
"error_code":"video_generation_failed","completed_at":1791353966}`，
`completed_at` 由上游 ISO 时间 `2026-10-07T06:19:26Z` 转成 Unix 秒，
下游拿到终态即停止轮询；该任务也把网关 `gateway_keys.used_quota` 归还（`updateTaskStatus` 的失败分支）。

完成态端到端实测（一条下游真实请求，`seconds=15`、`aspect_ratio=16:9`、带 4 张 `@图N` 参考图）：
经网关提交后轮询 `queued → processing → completed`（上游在 `pending` / `processing` 之间反复横跳约 9 分钟，
`progress` 在 `0 / 10 / 20 / 30` 之间来回），完成时网关返回
`status=completed`、`progress=100`、`video_url=http://<网关>/v1/videos/{id}/content`（代理地址）。
`GET /v1/videos/{id}/content` 实测：整片返回 `200 video/mp4`（2382176 字节，`accept-ranges: bytes`），
`Range: bytes=0-1023` 与 `bytes=1024-2047` 都返回 `206` 且 `content-range` 正确；
下载后用 ffprobe 读成品为 `hevc 1280x720`、时长 `15.07s`，说明下游的 `seconds` 与 `aspect_ratio`
确实按映射落到了上游（15 秒、16:9）。

注意 `/content` 与 `/v1/videos/{id}` 共用同一套 `poll_throttle` 节流：距上次轮询不足
`POLL_MIN_INTERVAL_SECONDS`（默认 6 秒）时，`/content` 会返回 `{"url":""}`（10 字节 JSON）而不是视频流，
稍等几秒重试即可；浏览器/播放器正常播放不受影响（Range 请求本身就是分开的几次调用）。

#### 按需转码：上游只给 HEVC 时的浏览器播放（`/content?format=h264`）

上游（豆包系）返回的成片是 **HEVC / H.265**（实测容器 `isom`、视频轨 `hvc1`、1280x720、`moov` 在文件开头，
即文件本身完全正常、可 Range 播放）。但 Chrome / Firefox 在多数环境下**无法解码 HEVC**，
播放器表现就是一直停在 `0:00` 加载不出来——这不是取流问题，而是编码问题。
上游不接受指定编码的参数（`codec` / `format` / `video_codec` / `resolution` 都会被忽略），
所以只能在网关侧转码。

网关提供按需转码，不改动已保存的任务地址：

| 入口 | 行为 |
|---|---|
| `GET /v1/videos/{id}/content` | 原样透传上游编码（HEVC 时浏览器可能放不出来） |
| `GET /v1/videos/{id}/content?format=h264` | 返回浏览器可播的 H.264/AAC mp4（首次请求触发转码并缓存） |
| `GET /v1/videos/{id}/content?format=h264&download=1` | 同上，但用 `Content-Disposition: attachment` 下载 |
| `GET /v1/videos/{id}/playback` | 报告该任务能否被浏览器直接播放，并给出 `browser_url`（H.264 地址） |

实现要点：

- `format` 取值为 `h264` / `avc` / `avc1` / `mp4`（大小写与空格容错）；不传 `format` 时行为与以前完全一致。
- 转码用 `ffmpeg -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -tag:v avc1 -c:a aac -movflags +faststart`，
  产物写进 `CONTENT_CACHE_DIR`（compose 里挂了 `content-cache` 卷），**每个任务只转一次**，
  之后（含容器重启后）直接读本地文件，秒开且支持 Range / `If-None-Match`（304）。
- 若上游某天返回的就是 H.264，则不做二次编码，直接把源文件发布进缓存（日志 `[Gateway H264 Passthrough]`）。
- 同一任务并发请求共享一次转码（`[Gateway H264 Transcode Start]` / `... Done`）；
  转码失败返回 502 `{"error":"H.264 transcoding failed","details":...}`，不会退化成 500 的 "Failed to poll upstream status"。
- 非代理绑定（`proxy_content = 0`）请求 `?format=h264` 时返回同源网关链接
  `{"url":".../content?format=h264"}`，由该链接完成转码，下游不需要自己拼参数。
- 需要 `ffmpeg` / `ffprobe`，已加进 `Dockerfile`（`apt-get install ffmpeg`）。
  可用 `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖路径，`CONTENT_H264_CRF`、`CONTENT_H264_PRESET`、
  `CONTENT_H264_AUDIO_BITRATE`、`CONTENT_H264_TIMEOUT_MS` 调整转码参数。
- 首次播放要多等一次转码时间（15 秒 720p 素材约十几秒量级），之后都是本地文件；播放器/插件只要把地址
  换成 `?format=h264` 即可，不需要改提交逻辑。


取流稳定性实测与修复（`upstream_status: 403` 那次）：某条已完成任务，上游 poll 返回的 `url` / `urls[0]`
是第三方直链 `https://v3-videoweb.doubao.com/...`，网关代理取流时该地址返回 `403 Forbidden`
（带 Bearer 与不带 Bearer 都一样，带 Range 也一样，响应体是 Apache 风格的 403 HTML 页面），
于是 `/content` 返回 `{"error":"Upstream video content request failed","upstream_status":403}`；
同时该任务用 `up_task_id` 直连 `{base_url}/v1/tasks/{task_id}/download` 是 `200 video/mp4`、
`Range` 返回 `206`，两者拿到的字节数完全一致（2031291 字节）。同一 CDN 直链过一段时间再访问又恢复 200，
说明它是**间歇性拒绝**（签名/风控/热点保护类），不能作为取流地址依赖。
修复动作有两层，都已落到当前配置：
1. `poll_mapping` 完成态改为优先返回站内下载接口地址（新提交的任务从第一次轮询完成起就走它）；
2. `server.js` 的 `proxyVideoContent` 增加兜底：401/403 时用站内下载地址重试一次，
   成功则正常返回视频并打 `[Gateway Video Proxy Fallback]` 日志。
修复后实测用户报的那条任务（`8451e57e-...`，用的是提交时保存的旧快照映射）取流恢复正常：
`GET /v1/videos/{id}/content` 返回 `200 video/mp4`、2031291 字节、含 `ftyp` box。

### 11.9 MCNIO GPT Image2（gpt-image-2-1k）

上游复用已存在的渠道 `MCNIO GPT Image`（`https://api.mcnio.com`，Bearer），
统一入口 `POST /v1/chat/completions`，同步返回，不轮询（`is_async = 0`、`proxy_content = 0`）。

**命名与 11.3 的 GPT Image 2.5 是两条不同产品线**，别互相套用：

| 产品线 | 上游模型名形态 | 本网关逻辑模型 |
|---|---|---|
| GPT Image2 | `gpt-image2-1k-16x9`（档位 1k/2k/4k；没有点号，没有 sunburst/flare） | `gpt-image-2-1k`（本节） |
| GPT Image 2.5 | `gpt-image-2.5-sunburst-2k-16x9`（档位 1k/2k/4k；带 sunburst / flare 变体） | `gpt-image-2.5-2k` / `gpt-image-2.5-4k`（11.3） |

分辨率和比例都写在上游模型名里，比例支持
`1x1` / `16x9` / `9x16` / `21x9` / `4x3` / `3x2` / `3x4` / `2x3` / `5x4` / `4x5`。
上游文档明确「文生图只需要提供文字提示词，不需要再额外传 `size` / `resolution` / `aspect_ratio`」，
因此映射只输出 `model` + `messages`，`quality` / `n` / `response_format` / `duration` /
`width` / `height` 都不下发（2.5 产品线实测传 `quality` 会 400，这条线同样不传，走上游默认质量）。

本网关只按分辨率分档暴露逻辑模型，比例由下游传：

- 逻辑模型 `gpt-image-2-1k`：下游传 `model` + `size`（比例，`16:9` / `16x9` / `16/9` 都接受，
  缺省 `1x1`），`req_mapping` 拼成上游 `gpt-image2-1k-{比例}`。
- `size` 缺失时兼容回落 `aspect_ratio`（按画幅字段调用的下游也能选对比例），两者都为空才用 `1x1`；
  `size` 优先于 `aspect_ratio`。白名单外的比例归一成 `x` 形式后原样交给上游判断，不做二次校验。
- 只接了 `1k` 档。2k / 4k 由既有逻辑模型 `gpt-image-2-2k`（绑定 #16，启用中）与
  `gpt-image-2-4k`（绑定 #17，停用中）各自绑定，**不要再给同渠道建第二条绑定**，
  否则同一逻辑模型会在两份映射之间随机路由。需要补 2k / 4k 时改这两条既有绑定即可，
  `buildReqMapping(tier)` 已按档位参数化，加一条 `models` 记录就能生成映射。

图生图：文字提示词作为 `messages[0].content` 的第一个 `text` 段，每张参考图各占一个独立的
`image_url` 段（对象 `{url}` 与裸字符串都接受，空值被过滤）；没有有效参考图时 `content`
退化为纯文本，走文生图。上游文档要求参考图 URL 必须能被上游服务器访问（建议 HTTPS 直链），
所以下游传的 `http(s)` 链接会原样透传；要让下游直接传 base64 / data URL，
打开该渠道的「请求 base64 转图床」开关（`channels.convert_base64_to_url`），
网关会先把 data URL 上传成 HTTPS 链接再发给上游（该开关是渠道级，会影响同渠道的其它绑定）。

返回归一：上游把结果放在 `choices[0].message.content`，常见形式是 Markdown 图片
`![Generated Image](https://img.mcnio.com/generated/xxx.png)`；
`resp_mapping` 把它归一到顶层 `url`（同时保留 `data[0].url` 与 `b64_json`），
兼容裸链接、data URL、整段裸 base64，以及 OpenAI 风格的 `data[0].url` / `data[0].b64_json` /
`image.url` / `image_urls[]`。上游限流或报错时 `content` 只是一句错误话术
（例如「未能生成图片」），此时 `url` 输出空字符串，不会把错误话术当成图片链接返回下游。
若上游某天改成只回内联 base64，打开该渠道的「响应 base64 转图床」开关
（`channels.convert_resp_base64_to_url`）即可让下游拿到 http 链接，映射本身无需改动。

模板与映射位于 `scripts/mcnio-gpt-image2-config.js`，配置脚本为 `scripts/add-mcnio-gpt-image2.js`
（`--dry-run` 预览 / `--apply` 写入，要求显式设置 `EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME` 并核对连接；
复用既有渠道、按 `model_name` 复用逻辑模型、按（逻辑模型，渠道）复用绑定，
重复执行只更新差异字段，不删除任何既有记录，也不改动渠道开关与密钥）。
上游模型清单可用 `node tools/probe-mcnio-image-models.js [关键字]` 复查
（只读 `GET /v1/models`，不发起计费请求，且不打印渠道密钥）。

2026-10 实测与校验：

- `GET https://api.mcnio.com/v1/models` 返回 115 个模型，`gpt-image2-1k-{10 个比例}` 全部存在，
  `gpt-image2-2k-*` 只有 `16x9` / `21x9` / `9x16`；`gpt-image-2.5-{sunburst,flare}-{1k,2k,4k}-{比例}`
  各 10 条也在列表里，与本仓库已有配置一致。
- `node --test test/mcnio-gpt-image2.test.js`（10 项）：覆盖 10 种比例的字面写法、`size` 缺省与
  `aspect_ratio` 回落、上游拒收字段不下发、图生图 `text + image_url` 段形状、空参考图退化、
  Markdown / 裸链接 / data URL 归一、错误话术不产生假链接。
- `node tools/verify-mcnio-gpt-image2.js [网关地址]`（11 项，全部通过）：在宿主机起一个 mock 上游
  （端口 `4611`，容器经 `host.docker.internal` 访问），临时建一条渠道 + 逻辑模型 + 绑定，
  **映射直接取自数据库里 `gpt-image-2-1k` 生产绑定的 `req_mapping` / `resp_mapping`**，
  走完整网关链路后无条件删除临时记录，生产渠道与绑定全程不变。实测断言了：
  上游收到 `POST /v1/chat/completions`、`Authorization: Bearer <渠道密钥>`、
  `model = gpt-image2-1k-16x9`（`size=16:9`）与 `gpt-image2-1k-1x1`（不传 `size`）、
  请求体只有 `model` + `messages`、图生图 3 段 content、上游 data URL 归一、错误话术 `url` 为空串。
- 按第 7.2 节第 11 条，**没有发送任何真实计费生成请求**：上游接口的可达性与模型名来自
  `GET /v1/models`，请求/响应形态来自 mock 端到端校验。需要确认真实出图时，
  可让下游对 `gpt-image-2-1k` 发一条 `size=16:9` 的 1K 请求（会真实计费）。
- 写映射时踩到的 JSONata 2.2.2 坑（与 11.3 同源）：
  1. 正则字面量里出现在字符类内的 `\/` 会被词法器提前当成结束符，报
     `No terminating / in regular expression`，URL 前缀判断只能用 `$substring`；
  2. `and` / `or` 不短路，判断「值是否可用」要先判类型再判内容；
  3. `$exists(null)` 为真，所以 `$exists(size)` 拦不住 `size: null`
     （会拼出 `gpt-image2-1k-null`），必须再加 `$type(size) != "null"`。

### 11.10 secure-skill 图片（gpt-image-2-1k/-2k/-4k、gemini-nano-banana-2.1-1k/-2k/-4k）

上游是 secure-skill（`https://token.secure-skill.com`，Bearer 鉴权，OpenAI 兼容入口要带 `/v1`），
新建渠道 `secure-skill 图片`。上游是**多个分组协议共用同一域名**：GPT Image 走 `/v1/images/*`，
Banana 走 Google 原生 `/v1beta/models/{model}:generateContent`，两套信封不能混用。

本次接入了两组、共六个逻辑模型，**两组都按分辨率档位拆成三个逻辑模型**：

| 逻辑模型 | 上游模型 ID | 上游入口 | 档位 | 绑定状态 |
|---|---|---|---|---|
| `gpt-image-2-1k` / `gpt-image-2-2k` / `gpt-image-2-4k` | `gpt-image-2` | `POST /v1/images/generations`（同步阻塞） | 1K / 2K / 4K | 1K、2K 启用；**4K 先停用** |
| `gemini-nano-banana-2.1-1k` / `-2k` / `-4k` | `gemini-nano-banana-2.1`（原样使用，三档共用） | `POST /v1beta/models/gemini-nano-banana-2.1:generateContent`（同步阻塞） | 1K / 2K / 4K（由模型名写死） | 三档都启用 |

档位一律由**逻辑模型名**决定，下游不用（也不能）用参数改档；下游只需要传比例
（`size` 或 `aspect_ratio`）。这样插件可以只按模型名选档，不需要解析额外参数。

配置与映射位于 `scripts/secure-skill-image-config.js`，配置脚本为
`scripts/add-secure-skill-image.js`（`--dry-run` 预览 / `--apply` 写入，要求显式设置
`EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME` 并核对连接）。脚本按 `name` / `base_url` 复用渠道、
按 `model_name` 复用逻辑模型、按（逻辑模型，渠道）复用绑定，重复执行只更新差异字段，
**从不写渠道密钥**，也不删除任何记录；只有配置里显式写 `status = 0` 的绑定
（目前是 `gpt-image-2-4k`）会在已存在时被强制停用，`status = 1` 的绑定不会覆盖后台手动的停用。
`gpt-image-2-1k` / `-2k` / `-4k` 是既有逻辑模型（原本只绑 MCNIO 渠道），本脚本只给它们追加一条
指向 secure-skill 的绑定，多绑定按 `weight` 随机路由。

Banana 2.1 从「单个 `gemini-nano-banana-2.1` 逻辑模型 + 下游传档位」改成三档拆分时，
用一次性迁移脚本 `scripts/migrate-banana-21-tiers.js`（`--dry-run` / `--apply`）：
它把裸名记录原地改名成 `-2k`（保住既有绑定 id），再补建 `-1k` / `-4k` 与其绑定，
最后删掉裸名记录。迁移是幂等的，并且会先检查裸名记录有没有被其它渠道引用。

#### 渠道开关

渠道创建时同时打开两个 base64 开关（同渠道所有绑定共用，见第 5 节）：

- `convert_base64_to_url = 1`：上游文档明确参考图只接受公网 HTTP(S) URL
  （不接受 multipart / data URL / base64），所以下游传的 `data:image/...` 必须由网关
  先上传图床换成 HTTPS 链接。
- `convert_resp_base64_to_url = 1`：Banana 的 `generateContent` **只回内联 Base64**
  （`candidates[].content.parts[].inlineData.data`），而下游统一模板要求 http 链接，
  由网关在响应映射之后把它换成图床链接。

#### GPT Image 2：档位放在模型名，比例由下游传

上游公开模型 ID 只有 `gpt-image-2` 一个（**质量由 API Key 所属分组决定，请求里不要写质量后缀**），
分辨率靠 `size`（宽x高）表达：命中上游预设表走该格像素与档位，表外 WxH 仅 `gpt-image-2`
支持自定义（宽高必须都是 16 的倍数）。本网关没有把上游几十个规格名暴露给下游，
而是按档位暴露三个逻辑模型，比例由下游 `size` 传：

- 下游 `size` 传比例（`16:9`、`16x9`、`16/9` 都接受），网关在该档位的预设表里查出上游像素；
  `size` 缺失时兼容回落 `aspect_ratio`，两者都为空用该档 `1:1`；`size` 优先于 `aspect_ratio`。
- 下游 `size` 直接写像素（如 `1920x1088`）时原样透传，由上游按自定义尺寸判断合法性
  （最短边 ≥ 256、最长边 ≤ 3840、宽高都是 16 的倍数，`1920x1080` 会被上游拒绝）。
- 固定下发 `model` / `prompt` / `size` / `response_format: "url"` / `n: 1`；
  参考图放顶层 `image`（`images` 映射过去，字符串或数组，上游最多 16 张）。
- **`quality` / `resolution` / `duration` / `width` / `height` 一律不下发**：上游 GPT Image 2
  不接受 `quality`（质量由分组决定），下游 `n` 也会被强制成 `1`（上游该模型只支持 1 张）。

上游 `gpt-image-2` 预设表（本次按文档逐格写入 `req_mapping`）：

| 比例 | 1K | 2K | 4K |
|---|---|---|---|
| 1:1 | 1024x1024 | 2048x2048 | 2880x2880 |
| 3:2 | 1536x1024 | 2048x1360 | 3504x2336 |
| 2:3 | 1024x1536 | 1360x2048 | 2336x3504 |
| 4:3 | 1024x768 | 2048x1536 | 3264x2448 |
| 3:4 | 768x1024 | 1536x2048 | 2448x3264 |
| 5:4 | 1280x1024 | 2560x2048 | 3200x2560 |
| 4:5 | 1024x1280 | 2048x2560 | 2560x3200 |
| 16:9 | 1536x864 | 2048x1152 | 3840x2160 |
| 9:16 | 864x1536 | 1152x2048 | 2160x3840 |
| 2:1 | 2048x1024 | 2688x1344 | 3840x1920 |
| 1:2 | 1024x2048 | 1344x2688 | 1920x3840 |
| 21:9 | 2016x864 | 2688x1152 | 3840x1648 |
| 9:21 | 864x2016 | 1152x2688 | 1648x3840 |

`resp_mapping` 直接沿用上游 OpenAI 兼容形状（`data[0].url` / `data[0].b64_json`），
归一到顶层 `url` / `b64_json` / `data[0]`；`data` 为空数组（上游视为失败）时 `url` 输出空串，
不会凭空造链接。上游 4xx/5xx 的 `{"error":{...}}` 形状由网关按 `error_passthrough = 1` 原样透传。

`gpt-image-2-4k` 的绑定按 `status = 0` 创建：上游文档声明支持 4K，但「模型是否可用以
API Key 所属分组为准」，确认分组开通后在后台启用即可（映射本身已可用，见校验结论）。

#### gemini-nano-banana-2.1：Google 原生同步入口

Banana 有三套信封（原生异步 `POST /v1/images/generations` + `GET /v1/images/generations/{id}`、
OpenAI 兼容异步、以及 `/v1beta/models/{model}:generateContent`）。本网关的同步图片入口
（`server.js` 的 `/v1/images/generations`）**没有图片任务的异步/轮询流程**，`is_async` 也只作用于
`/v1/videos`，所以这里只能选同步入口，最终采用 Google 原生 `generateContent`：

- 上游路径带模型名，`route_path` 为 `/v1beta/models/gemini-nano-banana-2.1:generateContent`；
  上游文档写明 `gemini-nano-banana-2.1` 按请求名原样使用。三个档位共用同一个上游模型与同一条路径，
  逻辑模型名只是网关侧的档位标签（`-1k` / `-2k` / `-4k`），请求体里的上游模型名不变。
- 请求体：`contents[0]` 是 `role: user`，`parts` 第一段是 `{text: prompt}`，
  参考图各占一段；`generationConfig.responseModalities = ["TEXT","IMAGE"]`，
  `generationConfig.imageConfig` 传**档位**（`1K` / `2K` / `4K`）与比例。
- 档位**写死在模型名里**：`imageSize` 直接由逻辑模型决定（`-4k` 恒为 `4K`），
  下游传 `image_size` / `resolution` / `size: "1K"` 之类都不会改变它。
  比例来源：下游 `aspect_ratio` > `size` 里的比例 > `1:1`；档位写法的 `size`（如 `size: "2K"`）
  不会被当成比例，按 `1:1` 处理。
- 参考图两种形态：data URL 拆成 `inlineData{mimeType, data}`（上游文档说明 `contents` 里的
  inlineData 会先上传再作为参考图）；公网 URL 放进 `fileData.fileUri` 原样透传。
  合计最多 16 张。
- 比例除通用比例（`1:1` / `16:9` / `9:16` / `3:2` / `2:3` / `4:3` / `3:4` / `4:5` / `5:4` / `21:9`）外，
  Banana 2.1 额外支持 **4:1 / 1:4 / 8:1 / 1:8**；上游的别名写法
  （`landscape` / `portrait` / `square` / `four-one` / `one-four` / `eight-one` / `one-eight`）
  与 `16x9` / `16/9` 也一并归一。**不支持 9:21**，也不支持 `size: "0x0"` 跟随参考图尺寸。
- 像素表（上游按「档位 + 比例」自己映射，网关只传档位与比例；此处记录文档值供排查）：

  | 比例 | 1K | 2K | 4K |
  |---|---|---|---|
  | 1:1 | 1024x1024 | 2048x2048 | 4096x4096 |
  | 16:9 | 1376x768 | 2752x1536 | 5504x3072 |
  | 9:16 | 768x1376 | 1536x2752 | 3072x5504 |
  | 3:2 | 1536x1024 | 3072x2048 | 6144x4096 |
  | 2:3 | 1024x1536 | 2048x3072 | 4096x6144 |
  | 4:3 | 1200x896 | 2400x1792 | 4800x3584 |
  | 3:4 | 896x1200 | 1792x2400 | 3584x4800 |
  | 5:4 | 1152x928 | 2304x1856 | 4608x3712 |
  | 4:5 | 928x1152 | 1856x2304 | 3712x4608 |
  | 21:9 | 1584x672 | 3168x1344 | 6336x2688 |
  | 4:1 | 2048x512 | 4096x1024 | 8192x2048 |
  | 1:4 | 512x2048 | 1024x4096 | 2048x8192 |
  | 8:1 | 2816x352 | 5632x704 | 11264x1408 |
  | 1:8 | 352x2816 | 704x5632 | 1408x11264 |

- 响应：`candidates[].content.parts[].inlineData` 归一到顶层 `url`（data URL）、
  `b64_json`、`images[]`（含 `mimeType`）与 `data[]`；文字段拼进 `revised_prompt`。
  只有文字、没有图片（上游限流/失败话术）时 `url` 输出空串、`count` 为 0，不会造链接。
  上游 4xx 的 `{"error":{...}}` 由 `error_passthrough = 1` 原样透传。
- 上游只回内联 Base64，所以渠道的「响应 base64 转图床」是必需的：校验里确认图床链接
  能真正下载回 PNG 字节。
- 连续编辑（多轮 `generateContent` 回放完整 `candidates[0].content`）需要会话上下文，
  不属于本网关的统一模板，未接入；需要时按上游文档在插件侧直接调上游。

#### 校验与实测（2026-10）

- `node --test test/secure-skill-image.test.js`（14 项，全部通过）：覆盖三个档位 × 13 个比例的
  逐格换算、`size` / `aspect_ratio` / 缺省与像素直传、上游拒收字段不下发、参考图归一、
  Banana 三档的「档位写死在模型名、下游传 1K/2K/4K 都不改档」与比例（含 4 个模型专属比例与全部别名）、
  `inlineData` / `fileData` 拆分、响应归一与「错误话术不产生假链接」、
  以及每条映射都能被本仓库 jsonata 解析。
- `node tools/verify-secure-skill-image.js [网关地址]`（20 项，全部通过）：在宿主机起 mock 上游
  （端口 `4612`，容器经 `host.docker.internal` 访问），临时建渠道 + 六个逻辑模型 + 六条绑定，
  **映射直接取自数据库里这六条生产绑定**，走完整网关链路后无条件删除临时记录，
  生产渠道与绑定全程不变。实测断言了：上游收到 `POST /v1/images/generations` 与
  `Authorization: Bearer <渠道密钥>`、`model` 固定 `gpt-image-2`、16:9 在 1K/2K 档分别落成
  `1536x864` / `2048x1152`、4K 档 1:1 落成 `2880x2880`、`quality` 等字段不下发、
  http 参考图原样透传而 data URL 被图床换成链接、Banana 三档各自下发
  `imageSize` = `1K`/`2K`/`4K`（对 `-4k` 故意传 `image_size: "1K"` 与 `resolution: "1K"` 仍落 `4K`）、
  上游收到 `/v1beta/models/gemini-nano-banana-2.1:generateContent` 且 `imageConfig` 为
  `{aspectRatio:"4:1",imageSize:"4K"}`、`inlineData` 归一成可下载的图床 PNG 链接、
  返回体里的 `model` 是下游调用的逻辑模型名、只回文字时 `url` 为空串。
- 按第 7.2 节第 11 条，**没有发送任何真实计费生成请求**：上游接口路径与模型名来自本文档，
  请求/响应形态来自 mock 端到端校验。
- 写这两个映射时踩到的 JSONata 2.2.2 坑（都是本仓库实测，写新映射必看）：
  1. `$map` / `$filter` 的匿名函数体**只能是单个表达式**，里面不能写 `$x := ...;` 赋值
     （会报 `Expected "}", got ";"`）。需要中间值时只能在函数体外用赋值语句算好，
     函数体内用嵌套三元表达式。
  2. `$map` 不提供 `$index` 变量（`$index` 在函数体里是 undefined），
     想按位置关联多个数组只能在一个 `$map` 里用嵌套三元算完。
  3. 单元素数组会被折成标量：`$map([x], ...)` 的结果是 `x` 而不是 `[x]`，
     因此「单张参考图」会输出字符串而不是数组（上游 `image` 两种都接受，
     但下游在写断言时要注意形状）。
  4. 正则字面量里的 `x` / `X` 必须先 `$lowercase`，且 `/^[0-9]{2,}[xX][0-9]{2,}$/`
     这类「像素」判断要用 2 位以上数字，否则 `16x9` 会被误判成像素。

#### 首次配置后需要做的一件事

渠道 `secure-skill 图片` 以 `api_key = NULL` 创建（上游文档只给了 `sk-your-key` 占位符，
真实 Key 需要登录上游后台、在 API Keys 页创建并为该 Key 选择已开通对应图片模型的分组）。
在网关后台该渠道里填入 Key 后即可调用；也可以由下游透传 Bearer Key。
填 Key 后建议先用 `GET {base_url}/v1/models` 确认分组已开通 `gpt-image-2` 与
`gemini-nano-banana-2.1`，再决定是否启用 `gpt-image-2-4k` 的绑定
（Banana 的 `-1k` / `-2k` / `-4k` 三条绑定已全部启用）。

### 11.11 MINIMAXH3（openaivideo.top）三个「采样」档位

新建渠道 `MINIMAXH3 视频`（`https://openaivideo.top`，Bearer 鉴权），异步视频流程：

- 提交：`POST /v1/videos/generations`（JSON 或 multipart，成功 HTTP 202 + `task_id`）；
  轮询：`GET /v1/tasks/{task_id}`（上游建议 3~5 秒一次）；
  下载：`GET /v1/tasks/{task_id}/download?index=0` 与
  `GET /v1/tasks/{task_id}/file/{name}?index=0`（同一份文件，需要 Bearer，支持 Range）。
- 鉴权头 `Authorization: Bearer <Key>`（也接受 `X-API-Key`，或只写 Key）；真实 Key 已写入
  `channels.api_key`，可用环境变量 `MINIMAXH3_API_KEY` 覆盖。
- 渠道字段：`channel` 用 `GET /v1/channels` 的 `name`（`default` = 显示名「低价」，
  `lumen` 是另一条只放 SD 系列模型的渠道）。本渠道**不写** `channel`，走上游默认渠道，
  避免把渠道名写死；这些档位都在默认渠道的模型表里。
- 上游文档只提供事实信息；页面里 `openmvideo.top` 是文档遗留文本，本渠道按实查可用的
  `https://openaivideo.top` 配置（该域名 `/api/config` 与 `/v1/models` 都返回 200）。

三个逻辑模型名与上游 model id 同名，`req_mapping` 里固定写死；档位与上限来自该 Key
`GET /v1/models` 的实查结果（只读、不计费）：

| 逻辑模型 | 上游 model | 时长 | 分辨率 | 图片 / 视频 / 音频上限 | modes |
|---|---|---|---|---|---|
| `MINIMAX-H3-2.5采样-101010` | 同名 | 4~30 整数秒 | 仅 720p | 10 / 10 / 10（合计 30） | first_last_frames、multi_frame、omni_reference |
| `MINIMAX-H3-2.5采样-301010` | 同名 | 4~30 整数秒 | 仅 720p | 30 / 10 / 10（合计 50） | first_last_frames、multi_frame、omni_reference |
| `MINIMAX-H3-2.0采样-933` | 同名 | 4~15 整数秒 | 仅 720p | 9 / 3 / 3（合计 15） | multi_frame、omni_reference（**没有 first_last_frames**） |

字段映射（下游统一模板 -> 上游）：

| 下游字段 | 上游字段 | 说明 |
|---|---|---|
| `prompt` | `prompt` | 必填，≤8000 字符；同时把 `@imgN` / `@vidN` / `@audN` 改写成 `@image_file_N` / `@video_file_N` / `@audio_file_N` |
| `seconds` | `duration` | 该档 4~上限的整数秒；缺失、越界（含 933 的 16+）、小数、非数字、空串一律回落 `5` |
| `aspect_ratio` | `ratio` | 该档白名单 `21:9` / `16:9` / `3:2` / `4:3` / `1:1` / `3:4` / `2:3` / `9:16` 内原样透传，缺失或白名单外回落 `16:9`（上游文档也要求不要传 `adaptive`） |
| `resolution` | `video_resolution` | 三个档位 `caps.res` 都只有 `720p`，固定下发 `"720p"`，下游传 `1080p` / `2k` 也不改变它 |
| `images` | `materials[]`（`type: "image"`） | `name` = `image_file_1`…`image_file_N`，超过该档 `maxImg` 按上限截断 |
| `videos` | `materials[]`（`type: "video"`） | `name` = `video_file_N`，按该档 `maxVid` 截断 |
| `audios` | `materials[]`（`type: "audio"`） | `name` = `audio_file_N`，按该档 `maxAudio` 截断 |
| 有无素材 | `function_mode` | 有素材 → `omni_reference`；没有素材 → 支持 `first_last_frames` 的档位走它（上游的文生视频路径），933 走 `omni_reference` |

素材与命名要点：

- 统一按 `omni_reference` 混合素材提交：下游模板没有「首帧 / 尾帧 / 多帧」这类角色字段，
  而三个档位都支持 `omni_reference`，一条映射即可覆盖图片、视频、音频的任意组合。
- 素材项接受字符串 URL、`{"url": "..."}` 对象、单个标量或数组；空串 / `null` / 无 `url` 的对象
  会被丢掉；单张素材也会输出**数组**（`$append` / `[...]` 组合，避免 JSONata 单元素折成标量）。
- 素材名固定为 `image_file_N` / `video_file_N` / `audio_file_N`：这是上游文档的「引用名是字段名」
  约定，也是站点自身 UI（角标 `@img1` / `@vid1` / `@aud1`，提交前改写成 `@image_file_1`）的做法。
  网关在 `req_mapping` 里做了同样的改写，所以下游 prompt 写 `@img1`、`@video_file_1` 都能对上。
- 素材 URL 必须能被上游服务器访问；渠道打开了「请求 base64 转图床」
  （`convert_base64_to_url = 1`），下游的 `data:image/...` 会先换成图床 HTTPS 链接。
  **视频与音频没有对应的转换**，必须是公网 `http(s)` URL。

上游返回与轮询：

- 提交响应 `{task_id, id?, status: "pending", model, created_at}`（ISO 8601），
  `resp_mapping` 取 `task_id`（兼容 `id` / `data.task_id`）；异步任务的网关任务号由
  `server.js` 生成，`resp_mapping` 只负责把上游任务号交出来。
- 轮询状态 `pending` / `submitted` / `generating` / `post_processing` / `finalizing` /
  `success` / `failed`：前两个与 `queued` 归一为 `queued`，中间三个与无法识别的状态归一为
  `processing`（不会把原始状态透传给下游），`success` → `completed`，`failed` / `canceled` →
  `failed`。
- 进度字段是 `progress_pct`（0~100 数字，也可能是字符串），另有 `progress_text` 文案；
  完成时固定输出 `100`。
- `created_at` / `completed_at` 是 ISO 8601 字符串，映射成 Unix 秒；终态缺 `completed_at`
  时用当前时间补齐，进行中输出 `null`。
- 失败原因在 `fail_reason`（用户可读中文，例如「内容审核未通过，请修改后重试」
  「参考图含未认证人脸，暂不支持生成」「生成时间过长，任务已结束，费用已退回，请重新提交」）。
  只要出现 `fail_reason` / `error` / `error_message`，**无论 `status` 停在哪个进行中状态**
  都落成终态 `failed`；失败但没有任何可读文本时输出 `上游任务失败: <status>`，避免下游一直轮询。
- 提交响应里那句提示性 `message`（`Task is still running; poll /v1/tasks/xxx.`）**不当作错误**，
  所以错误识别只看 `fail_reason` / `error` / `error_message`，不看通用 `message`。
- 结果有两个数组：`result_urls`（预览 / 播流）与 `source_urls`（高清原片，可能为空数组）。
  上游文档明确「轮询体里的 CDN 可能过期或防盗链，落盘请走 `/v1/tasks/{id}/download`」，
  因此完成后 `video_url` 固定拼站内下载地址
  `https://openaivideo.top/v1/tasks/{task_id}/download?index=0`，上游直链只保留在
  `upstream_result_url` 里供排查；没有 `task_id` 时才退回 `source_urls[0]` / `result_urls[0]`。

绑定与渠道开关：

- `is_async = 1`、`proxy_content = 1`（站内下载接口需要 Bearer 且支持 Range，由网关
  `/v1/videos/{id}/content` 代理取流；`channels.content_fallback_enabled = 1`，
  代理侧 401/403 时会再回退到站内下载接口）。
- `poll_throttle = 1`：生成时间非常长（上游约 3.5 小时没出结果就退费结束），
  上游文档写「默认 60 次/分钟」，而实查响应头是 `X-Ratelimit-Limit: 20`、`X-Generating-Limit: 20`
  （并发上限 20，与站点界面显示一致），轮询与提交共用这份额度，因此更要用节流；
  网关侧最小轮询间隔由 `POLL_MIN_INTERVAL_SECONDS`（默认 6 秒）控制，
  下游建议 10~15 秒轮询一次。注意 `/content` 与 `/v1/videos/{id}` 共用同一套节流：
  距上次轮询不足最小间隔时 `/content` 会返回 `{"url":""}`，稍等几秒重试即可（见 11.8 节）。
- `error_passthrough = 1`：上游提交失败（`400` 参数无效 / `402` 积分不足 / `429` 超限）的
  原始错误体直接透传给下游，便于排查参数问题。
- `convert_base64_to_url = 1`：见上「素材与命名要点」；`convert_resp_base64_to_url` 保持 `0`
  （成片是 mp4 链接，没有内联 base64）。

模板与映射位于 `scripts/minimaxh3-openaivideo-config.js`，配置脚本为
`scripts/add-minimaxh3-openaivideo.js`（`--dry-run` 预览 / `--apply` 写入，要求显式设置
`EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME` 并核对连接；渠道按 `name` / `base_url` 复用、
逻辑模型按 `model_name` 复用、绑定按（逻辑模型，渠道）复用，重复执行只更新差异字段，
不覆盖已有渠道密钥、不删除任何记录）。
映射可用 `node --test test/minimaxh3-openaivideo.test.js` 校验（12 项：档位上限、素材命名与截断、
`@imgN` 改写、`seconds` / `aspect_ratio` / `resolution` 归一、提交与轮询映射、
失败态与「提示性 message 不算失败」），不需要发起付费生成请求。

2026-11 配置时的实测与说明（**没有发送任何真实生成请求**，生成时间很长且会计费）：

- 用该 Key 实查 `GET /v1/models`（200）：`default` 渠道列出
  `MINIMAXH3-2.0采样`、`MINIMAX-H3-2.5采样`、`MINIMAX-H3-2.0采样-933`、
  `MINIMAX-H3-2.5采样-101010`、`MINIMAX-H3-2.5采样-301010`；本次只接入下游点名的三个档位，
  裸名 `minimaxH3` / `MINIMAXH3-2.0采样` / `MINIMAX-H3-2.5采样` 未建逻辑模型（需要时按本节加即可）。
- `GET /v1/tasks/{不存在的 id}` 返回 404，确认轮询路径与鉴权头形态正确（只读、不产生任务）。
- 用三个上游 model id 各发一条**故意不合法**的 JSON 提交（`Content-Type: application/json`、
  带 `function_mode` / `ratio` / `duration` / `video_resolution`、**不带 `prompt`**）：三条都返回
  HTTP 400 `{"error":"prompt 不能为空"}`，说明 JSON 提交路径可用、三个 model id 都被该 Key 接受，
  且上面这些字段没有触发参数错误；请求在参数校验阶段就被拒绝，**不会创建任务、不扣费**。
  作为对照，乱写的 model 名返回 400 `{"error":"该渠道不支持模型: ...","supported":[...]}`，
  `supported` 列表里包含本次接入的三个档位。
  注意：探测时命令行必须用 UTF-8 无 BOM 的 JSON 文件（`curl --data-binary @file`），
  否则中文 model id 会被按本地代码页发送、上游解析失败只回 `500 Internal server error`。
- 容器内实查 `https://openaivideo.top/v1/models` 返回 200，说明镜像的 CA 证书与出网正常。
- 配置已写入运行中的网关数据库（渠道 #39，逻辑模型 #247 / #248 / #249，绑定 #266 / #267 / #268），
  并通过运行中容器的后台接口复核；网关按请求实时读库，**不需要重启容器**。
- 需要真实出片时，由下游按上述三个模型名发一条请求即可（会真实计费）。上游 402/429
  会原样透传给下游。
- 写映射时踩到的 JSONata 2.2.2 坑（与 11.3 / 11.10 同源）：`$map` / `$filter` 的匿名函数体
  只能是单个表达式（不能写 `$x := ...;`）；`and` 不短路，`$length` / `$match` / `$toMillis`
  对 null、数字、非 ISO 字符串会抛错，所以每一步都先判类型再取值；`$filter(空数组)` 返回
  `undefined`（用 `$count()` 判空是安全的）；数组切片 `[[0..N-1]]` 只在块表达式（外层括号）里
  对变量上下界生效，因此上限用模板里的字面量生成。

### 11.12 AI666 Gemini（gemini-4-argon）：OpenAI 协议转 Gemini + SSE 透传

新建渠道 `AI666 Gemini`（`https://ai666.live`，Bearer），新增逻辑模型 `gemini-4-argon`，
同步 chat 流程（`is_async=0`、`proxy_content=0`、`error_passthrough=1`）。

上游是 new-api 系网关（响应头 `X-New-Api-Version` / `X-Oneapi-Request-Id`），走 **Gemini 原生协议**：

- 非流式：`POST /v1beta/models/gemini-4-argon:generateContent`
- 流式：`POST /v1beta/models/gemini-4-argon:generateContent?alt=sse`
- 鉴权：该站实测**同时接受** `x-goog-api-key: <Key>` 与 `Authorization: Bearer <Key>`
  （用 `generateContent` 空 body 实测两种头都返回 400 `contents is required`，不是 401），
  因此沿用网关现有的 `bearer` 类型，**没有新增鉴权头类型**。
- `GET /v1beta/models`（只读实查）只列出 `gemini-3.8-flash` 与 `gemini-4-argon`，本次只接后者。

#### 请求转换（OpenAI -> Gemini，全部由 `req_mapping` 表达，不改网关代码）

| 下游 OpenAI 字段 | 上游 Gemini 字段 | 说明 |
|---|---|---|
| `messages[]` | `contents[]` | `assistant` → `role: "model"`，其余非 system 角色 → `role: "user"`；`contents` 与每条的 `parts` **恒为数组**（见下「坑」） |
| `content` 字符串 | `parts: [{ text }]` | |
| `content[]` 里的 `text` 段 | `parts: [{ text }]` | 多个 text 段各占一个 part |
| `content[]` 里的 `image_url` | data URL → `parts: [{ inlineData: { mimeType, data } }]`；`http(s)` URL → `parts: [{ fileData: { fileUri } }]` | 其他 part 类型被丢弃 |
| `role: system` / `developer` | 顶层 `systemInstruction.parts[]` | 多条用空行拼接 |
| `temperature` | `generationConfig.temperature` | |
| `top_p` | `generationConfig.topP` | 缺省 **0.95** |
| `max_tokens` / `max_completion_tokens` | `generationConfig.maxOutputTokens` | 数字或纯数字字符串都接受，缺省不下发 |
| `n`（>1） | `generationConfig.candidateCount` | `n=1` 不下发 |
| `stop`（字符串或数组） | `generationConfig.stopSequences` | |
| `response_format.type = "json_object"` | `generationConfig.responseMimeType = "application/json"` | |
| `stream: true` | 路由改走 `?alt=sse`，并置网关内部标记 `_stream_passthrough: true` + `_stream_transform: "openai"` | 见下「流式：映射级能力与 OpenAI 化」 |

`tools` / `functions` / `tool_calls` **未做转换**，需要时再补。

#### 流式：映射级能力与 OpenAI 化

原来的 `/v1/chat/completions` 只会用 axios 缓冲上游响应、再套 `resp_mapping`（JSONata 无法表达
SSE），所以对 SSE 上游不可用。现在加了一组**按绑定可选**的映射级能力：

- `req_mapping` 输出 `"_stream_passthrough": true`（同时把 `_route_path` 指向 SSE 地址）
  表示「这个绑定不要缓冲，按流式处理」；下游请求带 `stream: true`（布尔或字符串 `"true"`）时生效。
  该标记与 `_route_path`、`_stream_transform` 一样属于网关元数据，**不会发给上游**
  （已加进 `MULTIPART_META_KEYS`）。
- 再加 `"_stream_transform": "openai"` 时，网关不原样转发，而是把上游的 **Gemini 事件转换成
  OpenAI 格式的 SSE**：
  - 先发一个 `choices[0].delta = {"role":"assistant","content":""}` 的角色 chunk；
  - 每个 Gemini 事件里的 `candidates[].content.parts[].text`（跳过 `thought` 段）累加成
    `choices[].delta.content` 增量 chunk（多个 candidate 按数组下标映射成 `choices[].index`）；
  - `finishReason` 映射成 OpenAI 的 `finish_reason`：`STOP`→`stop`、`MAX_TOKENS`→`length`、
    `SAFETY` / `RECITATION` / `BLOCKLIST` / `PROHIBITED_CONTENT` / `SPII` / `IMAGE_SAFETY`→`content_filter`，
    其他小写原样；收尾时若上游一直没给终态，也补一个 `stop` 终态；
  - `usage`（取自 `usageMetadata`）挂在最后一个 chunk 上，最后补 `data: [DONE]\n\n`；
  - `id` / `created` 优先采用上游的 `responseId` / `createTime`（ISO 转 Unix 秒），
    没有则网关生成 `chatcmpl-<hex>` 与当前秒；
  - 逐帧解析（HTTP 分片会拼接后再解析），坏帧只记日志跳过，不影响整条流；
  - 上游即使带 `alt=sse` 却只回一个 Gemini JSON 文档，也会被当成单事件转换并正常收尾。
- **不**加 `_stream_transform`（只有 `_stream_passthrough: true`）时保持**逐字节透传**：
  保留上游 `content-type`（`text/event-stream`）直接 pipe，适合下游本来就按 Gemini 事件解析的场景。
- 转成 OpenAI 格式时响应头重写为 `Content-Type: text/event-stream; charset=utf-8` +
  `Cache-Control: no-cache, no-transform`，并保留 `X-Accel-Buffering: no`（前端代理不缓冲）。
- 其他绑定、以及没声明透传的绑定，行为与以前完全一致（缓冲 + `resp_mapping`）。
- 上游非 2xx 时先缓冲错误体，再按 `error_passthrough` 原样返回状态码与错误体
  （new-api 的形状是 `{"error":{"message":...,"type":"new_api_error","code":...}}`）；
  下游断开时销毁上游连接。
- 非流式（下游不传 `stream`）走 `:generateContent`，由 `resp_mapping` 把 Gemini JSON 归一成
  OpenAI 风格 `chat.completion`（`choices[0].message.content` 由 `candidates[0].content.parts[].text`
  拼接，`finishReason` 小写进 `finish_reason`，`usageMetadata` 进 `usage`）。

#### 配置与验证

模板与映射位于 `scripts/ai666-gemini-config.js`，写入脚本为 `scripts/add-ai666-gemini.js`
（`--dry-run` 预览 / `--apply` 写入，要求显式设置 `EXPECTED_DB_HOST` 与 `EXPECTED_DB_NAME`；
渠道按 `name` / `base_url` 复用、逻辑模型按 `model_name` 复用、绑定按（逻辑模型，渠道）复用，
重复执行只更新差异字段、不覆盖已有密钥）。

- `node --test test/ai666-gemini.test.js`（11 项）：请求转换（contents / systemInstruction /
  generationConfig / 多模态 part）、流式与非流式的路由与标记、响应归一、
  `wantsStreamedResponse` / `isStreamPassthroughPayload` / `getStreamTransform` 三个纯函数，
  以及 Gemini→OpenAI 转换器（角色 chunk、增量、分片拼帧、终态、usage、坏帧 / 空事件、
  非 SSE 单 JSON 兜底、`finishReason` 映射）。
- `node tools/verify-ai666-gemini.js [网关地址] [网关密钥] [mock 端口]`（25 项，全部通过）：
  在宿主机起 mock Gemini 上游（端口 4621，容器经 `host.docker.internal` 访问），
  临时建两个绑定（**映射逐字取自生产绑定**，其中一个去掉 `_stream_transform`），
  走完整网关链路后无条件删除临时记录。实测断言：上游收到
  `/v1beta/models/gemini-4-argon:generateContent?alt=sse`、`Authorization: Bearer <渠道密钥>`、
  纯 Gemini 报文（`_route_path` / `_stream_passthrough` / `_stream_transform` 等网关字段没有泄漏）；
  流式返回是 OpenAI 格式（首个 chunk 为 assistant 角色、delta 拼起来等于完整回答、
  最后一个 chunk 带 `finish_reason: stop` 与 `usage`、以 `data: [DONE]` 收尾、返回体里没有
  `candidates` 原始字段、`id`/`created` 采用上游 `responseId`/`createTime`）；
  只带 `_stream_passthrough` 的绑定仍是逐字节透传；上游只回一个 JSON 文档时也能转成 OpenAI SSE；
  非流式收到不带 `alt=sse` 的路径且响应归一成 `chat.completion`；
  上游 429 时状态码与 `new_api_error` 错误体原样透传。
- 2026-10 真实调用（各一次、`max_tokens` 很小）：非流式经网关返回
  `{"object":"chat.completion","model":"gemini-4-argon","choices":[{"message":{"content":"OK"}}],"usage":{...}}`；
  流式经网关返回 `Content-Type: text/event-stream; charset=utf-8` + `Transfer-Encoding: chunked`，
  内容已经是 OpenAI 格式：

  ```
  data: {"id":"rlrQarb_LcjKmPUPpaKJuQs","object":"chat.completion.chunk","created":1792039598,"model":"gemini-4-argon","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

  data: {"id":"rlrQarb_LcjKmPUPpaKJuQs",...,"choices":[{"index":0,"delta":{"content":"1 2 "},"finish_reason":null}]}

  data: {"id":"rlrQarb_LcjKmPUPpaKJuQs",...,"choices":[{"index":0,"delta":{"content":"3"},"finish_reason":null}]}

  data: {"id":"rlrQarb_LcjKmPUPpaKJuQs",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":38,"completion_tokens":9,"total_tokens":47}}

  data: [DONE]
  ```

- 本次为支持流式改动改了 `server.js`（`_stream_passthrough` 流式分支、`_stream_transform`
  Gemini→OpenAI 转换器、`res.headersSent` 兜底），因此**需要重新构建并重启网关容器**才生效：
  `docker compose up -d --build gateway`；映射改动还要执行一次
  `node scripts/add-ai666-gemini.js --apply`（映射存在数据库里）。

写映射时又踩到的 JSONata 2.2.2 坑：`$map` / `$filter` 的结果是**序列**，只有单个元素时会折成
标量，导致 `contents` / `parts` 变成对象而不是数组（Gemini 要求数组）。修法是显式用数组构造器
包一层：`[$map(...)]`、`[$filter($map(...), ...)]`；`$join(undefined, "")` 返回 `undefined`，
要再判一次 `$type(...) = "string"` 才能保证 `content` 恒为字符串。


