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

module.exports = { pool, get, all, run, waitForConnection };
