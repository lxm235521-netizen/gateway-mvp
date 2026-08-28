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
    status TINYINT DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS logical_models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model_name VARCHAR(255) UNIQUE NOT NULL,
    status TINYINT DEFAULT 1,
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
    quota_released TINYINT DEFAULT 0,
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
