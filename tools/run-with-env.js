// 在本地按 .env 注入数据库等环境变量后运行指定脚本，供开发期核对/写入使用。
// 用法：node tools/run-with-env.js scripts/add-img688-gpt-image-2.js --dry-run
// 只是为了少敲几行环境变量；脚本本身仍会核对 EXPECTED_DB_HOST / EXPECTED_DB_NAME。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');

if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, '');
        if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
}

const [target, ...rest] = process.argv.slice(2);
if (!target) {
    console.error('用法: node tools/run-with-env.js <script> [args...]');
    process.exit(1);
}

process.env.EXPECTED_DB_HOST = process.env.EXPECTED_DB_HOST || process.env.DB_HOST;
process.env.EXPECTED_DB_NAME = process.env.EXPECTED_DB_NAME || process.env.DB_NAME;

const result = spawnSync(process.execPath, [path.resolve(root, target), ...rest], {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
});
process.exit(result.status === null ? 1 : result.status);
