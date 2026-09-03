const mysql = require("mysql2/promise");

const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "gateway",
    password: process.env.DB_PASSWORD || "gateway-password",
    database: process.env.DB_NAME || "gateway",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    charset: "utf8mb4"
});

async function get(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows[0];
}

async function all(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

async function run(sql, params = []) {
    const [result] = await pool.execute(sql, params);
    return result;
}

async function waitForConnection(retries = 30, delayMs = 2000) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            await pool.query("SELECT 1");
            return;
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
}

async function columnExists(tableName, columnName) {
    const row = await get(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        [tableName, columnName]
    );
    return Boolean(row);
}

async function addColumnIfMissing(tableName, columnName, definition) {
    if (!(await columnExists(tableName, columnName))) {
        await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}

async function migrate() {
    await run(`CREATE TABLE IF NOT EXISTS logical_models (
        id INT AUTO_INCREMENT PRIMARY KEY,
        model_name VARCHAR(255) UNIQUE NOT NULL,
        status TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_logical_models_model_name (model_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await run(`CREATE TABLE IF NOT EXISTS model_bindings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        logical_model_id INT NOT NULL,
        channel_id INT NOT NULL,
        route_path VARCHAR(1024) NOT NULL,
        poll_path VARCHAR(1024),
        api_key TEXT,
        is_async TINYINT DEFAULT 0,
        proxy_content TINYINT DEFAULT 0,
        req_mapping LONGTEXT NOT NULL,
        resp_mapping LONGTEXT NOT NULL,
        poll_mapping LONGTEXT,
        weight INT DEFAULT 1,
        status TINYINT DEFAULT 1,
        legacy_channel_model_id INT UNIQUE,
        INDEX idx_model_bindings_logical_model_id (logical_model_id),
        INDEX idx_model_bindings_channel_id (channel_id),
        INDEX idx_model_bindings_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await addColumnIfMissing("model_bindings", "proxy_content", "TINYINT DEFAULT 0");
    await addColumnIfMissing("async_tasks", "logical_model_id", "INT NULL");
    await addColumnIfMissing("async_tasks", "binding_id", "INT NULL");
    await addColumnIfMissing("async_tasks", "channel_id", "INT NULL");
    await addColumnIfMissing("async_tasks", "upstream_base_url", "VARCHAR(1024) NULL");
    await addColumnIfMissing("async_tasks", "poll_path_snapshot", "VARCHAR(1024) NULL");
    await addColumnIfMissing("async_tasks", "poll_mapping_snapshot", "LONGTEXT NULL");
    await addColumnIfMissing("async_tasks", "upstream_api_key_snapshot", "TEXT NULL");
    await addColumnIfMissing("async_tasks", "proxy_content_snapshot", "TINYINT NULL");
    await addColumnIfMissing("async_tasks", "quota_released", "TINYINT DEFAULT 0");

    await run(`INSERT IGNORE INTO logical_models (model_name, status)
        SELECT model_name, MAX(status)
        FROM channel_models
        GROUP BY model_name`);

    await run(`INSERT IGNORE INTO model_bindings (
            logical_model_id,
            channel_id,
            route_path,
            poll_path,
            api_key,
            is_async,
            req_mapping,
            resp_mapping,
            poll_mapping,
            weight,
            status,
            legacy_channel_model_id
        )
        SELECT
            lm.id,
            cm.channel_id,
            cm.route_path,
            cm.poll_path,
            cm.api_key,
            cm.is_async,
            cm.req_mapping,
            cm.resp_mapping,
            cm.poll_mapping,
            cm.weight,
            cm.status,
            cm.id
        FROM channel_models cm
        JOIN logical_models lm ON lm.model_name = cm.model_name`);

    await run(`UPDATE async_tasks t
        JOIN model_bindings b ON b.legacy_channel_model_id = t.model_id
        JOIN channels c ON c.id = b.channel_id
        SET
            t.logical_model_id = COALESCE(t.logical_model_id, b.logical_model_id),
            t.binding_id = COALESCE(t.binding_id, b.id),
            t.channel_id = COALESCE(t.channel_id, b.channel_id),
            t.upstream_base_url = COALESCE(t.upstream_base_url, c.base_url),
            t.poll_path_snapshot = COALESCE(t.poll_path_snapshot, b.poll_path),
            t.poll_mapping_snapshot = COALESCE(t.poll_mapping_snapshot, b.poll_mapping),
            t.upstream_api_key_snapshot = COALESCE(t.upstream_api_key_snapshot, b.api_key, c.api_key)
        WHERE t.binding_id IS NULL AND t.model_id IS NOT NULL`);
}

module.exports = { pool, get, all, run, waitForConnection, migrate };
