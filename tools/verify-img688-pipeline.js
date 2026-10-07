// 端到端验证：把本地 mock 上游挂到 gpt-image-2 逻辑模型上，走完整网关链路
// （请求映射 -> mock 上游 -> 响应映射 -> 响应侧 base64 转图床链接），跑完自动清理。
//
// 用法：node tools/verify-img688-pipeline.js [网关地址]
// 说明：只验证「网关 -> 上游 -> 图床 -> 下游」的链路与返回形态，不发送任何付费生成请求。
//       会临时创建一个测试渠道与绑定，结束后无条件删除。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const GATEWAY = process.argv[2] || 'http://127.0.0.1:3009';
const MOCK_KEY = 'sk-mock-688';
const CHANNEL_NAME = 'ZZ 临时校验 688 mock';
const MOCK_BASE = 'http://host.docker.internal:4599';

// 复用 .env 里的数据库连接，脚本自身只做临时记录的增删。
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}
const db = require('../db');
const { req_mapping, resp_mapping } = require('../scripts/img688-gpt-image-2-config');

const results = [];
function record(name, passed, detail) {
    results.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function callGateway(prompt, images) {
    const response = await fetch(`${GATEWAY}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MOCK_KEY}` },
        body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '1:1', quality: 'high', n: 1, ...(images ? { images } : {}) })
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
}

// 1x1 PNG，仅用于触发映射的 images/edits 分支（multipart），不会真的发给 688。
const REF_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';

const IMAGE_LINK = /^https:\/\/files\.mmg\.lat\/u\/[A-Za-z0-9-]+\.png$/;

// 容器重启后立刻打请求会 fetch failed，这里先等网关健康。
async function waitForGateway(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${GATEWAY}/healthz`);
            if (response.ok) return true;
        } catch (error) { /* 还没起来 */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

async function main() {
    assert.ok(await waitForGateway(), `网关 ${GATEWAY} 未就绪`);
    // 1) 建立一个临时渠道：base_url 指向 mock，密钥用 mock key。
    const existing = await db.get('SELECT id FROM channels WHERE name = ?', [CHANNEL_NAME]);
    if (existing) {
        await db.run('DELETE FROM model_bindings WHERE channel_id = ?', [existing.id]);
        await db.run('DELETE FROM channels WHERE id = ?', [existing.id]);
    }
    const channelResult = await db.run(
        'INSERT INTO channels (name, base_url, auth_type, api_key, status, convert_resp_base64_to_url) VALUES (?,?,?,?,1,1)',
        [CHANNEL_NAME, MOCK_BASE, 'bearer', MOCK_KEY]
    );
    const channelId = channelResult.insertId;
    const model = await db.get("SELECT id FROM logical_models WHERE model_name = 'gpt-image-2'");
    assert.ok(model, 'logical model gpt-image-2 must exist');
    const bindingResult = await db.run(
        `INSERT INTO model_bindings
            (logical_model_id, channel_id, route_path, poll_path, api_key, is_async, proxy_content, error_passthrough, poll_throttle, req_mapping, resp_mapping, poll_mapping, weight, status)
         VALUES (?,?,?,NULL,NULL,0,0,1,0,?,?,NULL,1,1)`,
        [model.id, channelId, '/v1/chat/completions', req_mapping, resp_mapping]
    );
    console.log(`临时渠道 #${channelId} / 绑定 #${bindingResult.insertId} 已建立（weight=1，与既有绑定并行）`);

    // 只让临时绑定参与路由：临时停掉其它 gpt-image-2 绑定，结束后**按原状态**恢复
    // （原先就是停用的绑定不能被这个脚本顺手启用）。
    const others = await db.all(
        "SELECT id, status FROM model_bindings WHERE logical_model_id = ? AND id <> ?",
        [model.id, bindingResult.insertId]
    );
    for (const row of others) {
        if (Number(row.status) === 1) {
            await db.run('UPDATE model_bindings SET status = 0 WHERE id = ?', [row.id]);
        }
    }
    console.log(`临时停用其它启用中的 gpt-image-2 绑定: ${others.filter(row => Number(row.status) === 1).map(row => `#${row.id}`).join(', ') || '无'}`);

    try {
        const cases = [
            { name: 'data URL（统一模板文生图）', prompt: 'mock dataurl 一只猫', expectImage: true },
            { name: 'data URL（带参考图 -> images/edits multipart）', prompt: 'mock dataurl 换成蓝色背景', images: [REF_IMAGE], expectImage: true },
            { name: 'Markdown 里的 data URL', prompt: 'mock rawb64 城市夜景', expectImage: true },
            { name: 'http 链接原样返回', prompt: 'mock wanturl 城市夜景', expectImage: true, expectRaw: true },
            { name: '上游限流错误话术不产生假链接', prompt: 'mock plain 一只猫', expectImage: false }
        ];

        for (const item of cases) {
            const { status, body } = await callGateway(item.prompt, item.images);
            const url = body && body.url;
            if (item.expectImage) {
                const ok = status === 200 && typeof url === 'string' && (item.expectRaw ? /^https?:\/\//.test(url) : IMAGE_LINK.test(url));
                record(item.name, ok, `status=${status} url=${typeof url === 'string' ? `${url.slice(0, 70)}…` : url}`);
                if (!item.expectRaw) {
                    // 顺手确认图床链接真的可下载
                    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
                    record(`${item.name} · 图床链接可访问`, Boolean(head && head.ok), head ? `HEAD ${head.status}` : 'HEAD 失败');
                }
            } else {
                const ok = status === 200 && (url === '' || url === null || url === undefined);
                record(item.name, ok, `status=${status} url=${JSON.stringify(url)}`);
            }
            // 返回体里不能残留 base64
            const raw = JSON.stringify(body);
            record(`${item.name} · 返回体不含 base64 数据`, !raw.includes('base64,') && raw.length < 2000, `body 长度 ${raw.length}`);
        }
    } finally {
        await db.run('DELETE FROM model_bindings WHERE id = ?', [bindingResult.insertId]);
        await db.run('DELETE FROM channels WHERE id = ?', [channelId]);
        for (const row of others) {
            await db.run('UPDATE model_bindings SET status = ? WHERE id = ?', [Number(row.status), row.id]);
        }
        console.log(`清理完成：临时渠道 #${channelId}、绑定 #${bindingResult.insertId} 已删除，其它绑定状态已按原值恢复`);
    }

    const failed = results.filter(item => !item.passed);
    console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length) {
        process.exitCode = 1;
    }
}

main()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.pool.end());
