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

当前代码会在轮询后自动覆盖 `id` 和 `task_id` 为网关任务号。`poll_mapping` 只需要把上游状态、进度、错误和真实结果 URL 映射出来。

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
- `convert_base64_to_url`：`1` 时，提交到该渠道前会将请求体中 `data:image/...;base64,...` 图片上传到 `https://wgspai.cn/image-bed/api/upload`，并替换为返回的 HTTPS URL；`0` 保持原样。

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
- 上游模型名固定时，在 `req_mapping` 中写死真实上游模型名。
- 异步提交响应必须把上游任务 ID 映射成 `task_id`。
- 轮询完成响应必须把上游成品 URL 映射成 `video_url`。
- 状态枚举要归一到网关模板常用值：`queued`、`processing`、`completed`、`failed`。

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

## 11. 非 Bearer 渠道与 Vylai MiniMax H3

渠道的 `auth_type` 默认为 `bearer`，也可在后台选择 `x-auth-token`。
后者把选中的上游密钥发送为 `X-Auth-Token: <key>`；密钥优先级不变。
提交、轮询和开启代理时的同源视频内容请求均使用该方式。新任务保存
`upstream_auth_type_snapshot`，旧任务无快照时继续使用 Bearer。
修改已有渠道鉴权方式不会改变已提交任务。

Vylai MiniMax H3 使用 `https://queueapi.vylai.com`，鉴权为 `x-auth-token`。
三个模板及可复用的映射位于 `scripts/vylai-minimax-config.js`。
`prompt` 映射为 `extra_data.text`，`seconds` 映射为 `config_values.duration`，
`aspect_ratio` 映射为 `config_values.aspect`；图片与音频分别使用 `image_path`、`audio_path`。
Fast 模板必须提供图片且不支持音频，所有模板都不映射视频输入。
未提供 resolution 时省略该配置，使用上游模板默认值。
创建响应使用 `data.task_id`，完成结果使用 `data.result_oss_url`，按结果直链返回。
文档未提供真实 Key，首次配置后需要在后台填写渠道默认密钥，或通过下游 Bearer Key 透传上游 Key。

在运行中的网关容器内执行配置脚本，以复用其实际数据库连接；脚本要求显式设置
`EXPECTED_DB_HOST` 和 `EXPECTED_DB_NAME` 并核对连接，匹配已有记录时不会重复添加。
配置脚本只创建渠道和模型，不发起付费生成请求。
