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

## 4. 图片生成下游模板

下游图片生成统一请求目前也按统一字段进入网关：

```json
{
  "model": "logical-image-model-name",
  "prompt": "一只在月光下的猫，插画风格",
  "quality": "high",
  "n": 1,
  "size": "16:9",
  "response_format": "url",
  "images": [
    "base64 或者 https 链接",
    "base64 或者 https 链接"
  ]
}
```

下游图片返回建议格式：

```json
{
  "model": "logical-image-model-name",
  "url": "base64 或 url"
}
```

新增图片模型时同样遵循统一字段到上游字段的映射原则。若上游是 OpenAI 兼容图片接口，通常映射 `prompt`、`quality`、`n`、`size`、`response_format`、`images` 即可。若上游需要 multipart，则 `req_mapping` 可输出带 `_request_format`、`fields`、`files`、`_file_fields` 的对象，具体以 `server.js` 中 multipart 支持为准。

## 5. 数据库配置字段

### channels

- `name`：渠道名称，便于后台识别。
- `base_url`：上游基础地址，不含具体接口路径时最好不要以多余路径结尾。例如上游完整地址是 `https://example.com/v1/videos`，则 `base_url` 可填 `https://example.com/v1`，`route_path` 填 `/videos`。
- `api_key`：上游固定密钥。若为空，网关会尝试使用下游传入的 Bearer key 透传给上游。
- `status`：`1` 启用，`0` 禁用。

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

## 7. 新增视频渠道检查清单

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

## 9. 容易出错的点

- 不要把下游模板字段改成上游字段。应该在 `req_mapping` 中翻译。
- 不要忘记异步提交响应的 `task_id`，否则网关无法保存上游任务号。
- 不要忘记轮询完成响应的 `video_url`，否则 `/content` 无法拿到视频地址。
- 不要把上游 `in_progress` 原样返回给下游模板，建议归一为 `processing`。
- 不要映射上游不支持的媒体字段。
- 不要把上游文档里的示例 URL、示例 key、示例 prompt 当成生产配置。
- 如果下游使用网关自有 key，必须在渠道或绑定中配置上游 key，否则上游请求可能没有有效鉴权。
