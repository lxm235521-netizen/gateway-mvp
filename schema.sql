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
    status VARCHAR(32) DEFAULT 'queued',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_async_tasks_model_id (model_id),
    INDEX idx_async_tasks_gw_key_id (gw_key_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
