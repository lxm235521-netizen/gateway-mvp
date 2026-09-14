CREATE TABLE IF NOT EXISTS gateway_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api_key VARCHAR(255) UNIQUE NOT NULL,
    quota INT DEFAULT 0,
    used_quota INT DEFAULT 0,
    status TINYINT DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    base_url VARCHAR(1024) NOT NULL,
    api_key TEXT,
    auth_type VARCHAR(32) NOT NULL DEFAULT 'bearer',
    convert_base64_to_url TINYINT NOT NULL DEFAULT 0,
    status TINYINT DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS logical_models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model_name VARCHAR(255) UNIQUE NOT NULL,
    status TINYINT DEFAULT 1,
    remark TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_logical_models_model_name (model_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS model_bindings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    logical_model_id INT NOT NULL,
    channel_id INT NOT NULL,
    route_path VARCHAR(1024) NOT NULL,
    poll_path VARCHAR(1024),
    api_key TEXT,
    is_async TINYINT DEFAULT 0,
    proxy_content TINYINT DEFAULT 0,
    error_passthrough TINYINT DEFAULT 1,
    poll_throttle TINYINT DEFAULT 0,
    req_mapping LONGTEXT NOT NULL,
    resp_mapping LONGTEXT NOT NULL,
    poll_mapping LONGTEXT,
    weight INT DEFAULT 1,
    status TINYINT DEFAULT 1,
    legacy_channel_model_id INT UNIQUE,
    INDEX idx_model_bindings_logical_model_id (logical_model_id),
    INDEX idx_model_bindings_channel_id (channel_id),
    INDEX idx_model_bindings_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    channel_id INT,
    model_name VARCHAR(255) NOT NULL,
    route_path VARCHAR(1024) NOT NULL,
    poll_path VARCHAR(1024),
    api_key TEXT,
    is_async TINYINT DEFAULT 0,
    req_mapping LONGTEXT NOT NULL,
    resp_mapping LONGTEXT NOT NULL,
    poll_mapping LONGTEXT,
    weight INT DEFAULT 1,
    status TINYINT DEFAULT 1,
    INDEX idx_channel_models_model_name (model_name),
    INDEX idx_channel_models_channel_id (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS async_tasks (
    gw_task_id VARCHAR(255) PRIMARY KEY,
    up_task_id VARCHAR(255) NOT NULL,
    gw_key_id INT,
    model_id INT,
    logical_model_id INT,
    binding_id INT,
    channel_id INT,
    upstream_base_url VARCHAR(1024),
    poll_path_snapshot VARCHAR(1024),
    poll_mapping_snapshot LONGTEXT,
    upstream_api_key_snapshot TEXT,
    upstream_auth_type_snapshot VARCHAR(32) NULL,
    proxy_content_snapshot TINYINT NULL,
    poll_throttle_snapshot TINYINT NULL,
    quota_released TINYINT DEFAULT 0,
    last_poll_at DATETIME NULL,
    status VARCHAR(32) DEFAULT 'queued',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_async_tasks_model_id (model_id),
    INDEX idx_async_tasks_binding_id (binding_id),
    INDEX idx_async_tasks_gw_key_id (gw_key_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO channels (name, base_url, api_key, status)
SELECT 'Grok Video', 'https://snumom.com', NULL, 1
WHERE NOT EXISTS (
    SELECT 1 FROM channels WHERE name = 'Grok Video' AND base_url = 'https://snumom.com'
);

INSERT INTO channels (name, base_url, api_key, status)
SELECT 'YU25 Seedance 视频', 'https://api.yu25.xyz/v1', 'sk-c5242e9efddaf788614fba7be6a92daec6f3b1e9afbe971cd6146623000a0a8b', 1
WHERE NOT EXISTS (
    SELECT 1 FROM channels WHERE name = 'YU25 Seedance 视频' AND base_url = 'https://api.yu25.xyz/v1'
);

INSERT IGNORE INTO logical_models (model_name, status)
VALUES ('sd-2-v4', 1), ('SD2.0 满血', 1);

INSERT INTO model_bindings (
    logical_model_id, channel_id, route_path, poll_path, api_key, is_async,
    proxy_content, error_passthrough, poll_throttle, req_mapping, resp_mapping,
    poll_mapping, weight, status
)
SELECT
    lm.id, c.id, '/videos', '/videos/${up_task_id}', NULL, 1,
    1, 0, 0,
    '$merge([{ "model": "sd-2-v4", "prompt": prompt, "seconds": $number(seconds), "resolution": $exists(resolution) ? resolution : "720p", "aspect_ratio": $exists(aspect_ratio) ? aspect_ratio : "16:9" }, ($count(images) > 0) ? { "images": images } : {}, ($count(videos) > 0) ? { "video_urls": videos } : {}, ($count(audios) > 0) ? { "audio_urls": audios } : {}])',
    '{ "task_id": $exists(task_id) ? task_id : ($exists(id) ? id : request_id), "id": $exists(id) ? id : ($exists(task_id) ? task_id : request_id), "status": $exists(status) ? status : "queued", "progress": $exists(progress) ? progress : 0, "object": $exists(object) ? object : "video", "model": $exists(model) ? model : "sd-2-v4", "created_at": created_at }',
    '(
        $status := $lowercase(status);
        $resultUrl := $exists(video_url) ? video_url : ($exists(result_url) ? result_url : ($exists(output_url) ? output_url : ($exists(download_url) ? download_url : ($exists(url) ? url : data.url))));
        {
            "created_at": created_at,
            "model": $exists(model) ? model : "sd-2-v4",
            "object": ($status = "completed" or $status = "succeeded" or $status = "success") ? $resultUrl : "video.generation",
            "progress": ($status = "completed" or $status = "succeeded" or $status = "success") ? 100 : ($exists(progress) ? progress : 0),
            "status": ($status = "completed" or $status = "succeeded" or $status = "success" or $status = "done" or $status = "finished") ? "completed" : (($status = "failed" or $status = "error" or $status = "rejected" or $status = "cancelled" or $status = "canceled") ? "failed" : (($status = "queued" or $status = "pending" or $status = "submitted") ? "queued" : "processing")),
            "video_url": $resultUrl,
            "result_url": $resultUrl,
            "error": $exists(error) ? error : ($exists(fail_reason) ? fail_reason : message),
            "completed_at": completed_at
        }
    )',
    1, 1
FROM logical_models lm
JOIN channels c ON c.name = 'YU25 Seedance 视频' AND c.base_url = 'https://api.yu25.xyz/v1'
WHERE lm.model_name = 'sd-2-v4'
  AND NOT EXISTS (
      SELECT 1 FROM model_bindings b
      WHERE b.logical_model_id = lm.id AND b.channel_id = c.id
  );

INSERT INTO model_bindings (
    logical_model_id, channel_id, route_path, poll_path, api_key, is_async,
    proxy_content, error_passthrough, poll_throttle, req_mapping, resp_mapping,
    poll_mapping, weight, status
)
SELECT
    lm.id, c.id, '/videos', '/videos/${up_task_id}', NULL, 1,
    1, 0, 0,
    '$merge([{ "model": "SD2.0 满血", "prompt": prompt, "seconds": $number(seconds), "resolution": $exists(resolution) ? resolution : "720p", "aspect_ratio": $exists(aspect_ratio) ? aspect_ratio : "16:9" }, ($count(images) > 0) ? { "images": images } : {}, ($count(videos) > 0) ? { "video_urls": videos } : {}, ($count(audios) > 0) ? { "audio_urls": audios } : {}])',
    '{ "task_id": $exists(task_id) ? task_id : ($exists(id) ? id : request_id), "id": $exists(id) ? id : ($exists(task_id) ? task_id : request_id), "status": $exists(status) ? status : "queued", "progress": $exists(progress) ? progress : 0, "object": $exists(object) ? object : "video", "model": $exists(model) ? model : "SD2.0 满血", "created_at": created_at }',
    '(
        $status := $lowercase(status);
        $resultUrl := $exists(video_url) ? video_url : ($exists(result_url) ? result_url : ($exists(output_url) ? output_url : ($exists(download_url) ? download_url : ($exists(url) ? url : data.url))));
        {
            "created_at": created_at,
            "model": $exists(model) ? model : "SD2.0 满血",
            "object": ($status = "completed" or $status = "succeeded" or $status = "success") ? $resultUrl : "video.generation",
            "progress": ($status = "completed" or $status = "succeeded" or $status = "success") ? 100 : ($exists(progress) ? progress : 0),
            "status": ($status = "completed" or $status = "succeeded" or $status = "success" or $status = "done" or $status = "finished") ? "completed" : (($status = "failed" or $status = "error" or $status = "rejected" or $status = "cancelled" or $status = "canceled") ? "failed" : (($status = "queued" or $status = "pending" or $status = "submitted") ? "queued" : "processing")),
            "video_url": $resultUrl,
            "result_url": $resultUrl,
            "error": $exists(error) ? error : ($exists(fail_reason) ? fail_reason : message),
            "completed_at": completed_at
        }
    )',
    1, 1
FROM logical_models lm
JOIN channels c ON c.name = 'YU25 Seedance 视频' AND c.base_url = 'https://api.yu25.xyz/v1'
WHERE lm.model_name = 'SD2.0 满血'
  AND NOT EXISTS (
      SELECT 1 FROM model_bindings b
      WHERE b.logical_model_id = lm.id AND b.channel_id = c.id
  );
INSERT INTO channel_models (
    channel_id, model_name, route_path, poll_path, api_key, is_async,
    req_mapping, resp_mapping, poll_mapping, weight, status
)
SELECT
    c.id, 'grok-imagine-video-1.5（按次）', '/v1/videos', '/v1/videos/${up_task_id}', NULL, 1,
    '{\n  "model": "grok-imagine-video-1.5（按次）",\n  "prompt": prompt,\n  "duration": $number(seconds),\n  "extra": {\n    "aspect_ratio": aspect_ratio,\n    "resolution": resolution,\n    "reference_images": $map(images, function($image) {\n      {"url": $image, "role": "reference_image"}\n    })\n  }\n}',
    '{\n  "task_id": id,\n  "status": status\n}',
    '{\n  "status": status,\n  "progress": progress,\n  "video_url": video_url,\n  "seconds": seconds,\n  "created_at": created_at\n}',
    1, 1
FROM channels c
WHERE c.name = 'Grok Video'
  AND c.base_url = 'https://snumom.com'
  AND NOT EXISTS (
      SELECT 1 FROM channel_models m
      WHERE m.model_name = 'grok-imagine-video-1.5（按次）'
        AND m.channel_id = c.id
  );

INSERT IGNORE INTO logical_models (model_name, status)
SELECT model_name, MAX(status)
FROM channel_models
GROUP BY model_name;

INSERT IGNORE INTO model_bindings (
    logical_model_id, channel_id, route_path, poll_path, api_key, is_async,
    req_mapping, resp_mapping, poll_mapping, weight, status, legacy_channel_model_id
)
SELECT
    lm.id, cm.channel_id, cm.route_path, cm.poll_path, cm.api_key, cm.is_async,
    cm.req_mapping, cm.resp_mapping, cm.poll_mapping, cm.weight, cm.status, cm.id
FROM channel_models cm
JOIN logical_models lm ON lm.model_name = cm.model_name;
