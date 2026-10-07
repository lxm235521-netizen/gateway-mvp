#!/bin/sh
# 预先下载 ffmpeg + ca-certificates 的完整依赖闭包到 .docker-ffmpeg-debs/，
# 供 Dockerfile 用 dpkg 离线安装。这样镜像构建完全不依赖 apt 能否连上镜像站。
#
# 为什么需要它：node:20-bookworm-slim 自带 /etc/apt/sources.list.d/debian.sources
# （指向 deb.debian.org）。在 deb.debian.org 不可达的网络里，apt 的 http 方法会
# 无限挂起（不触发超时），实测把镜像构建卡了近 1 小时。而本脚本用 node fetch
# 逐个下载、每个文件带硬超时，失败可重试，因此可在这种网络下稳定完成。
#
# 用法（在仓库根目录）：
#   docker run --rm -v "$PWD/.docker-ffmpeg-debs:/debs" -v "$PWD/tools:/t:ro" \
#     node:20-bookworm-slim sh /t/fetch-ffmpeg-debs.sh
# 可用环境变量覆盖镜像源：APT_MIRROR=http://mirrors.ustc.edu.cn
set -u

DEBS=/debs
MIRROR="${APT_MIRROR:-http://mirrors.tuna.tsinghua.edu.cn}"
mkdir -p "$DEBS"

# 关键：删掉镜像自带的 debian.sources，否则 apt 仍会去连不可达的 deb.debian.org。
rm -f /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list
printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "0";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\n' > /etc/apt/apt.conf.d/99vendored
echo "deb ${MIRROR}/debian bookworm main" > /etc/apt/sources.list
echo "deb ${MIRROR}/debian-security bookworm-security main" >> /etc/apt/sources.list

echo "=== apt-get update（源: ${MIRROR}）==="
start=$(date +%s)
if ! timeout 300 apt-get update -qq; then
    echo "apt-get update 失败：检查 ${MIRROR} 是否可达（可换 APT_MIRROR）" >&2
    exit 1
fi
echo "ok，用时 $(( $(date +%s) - start )) 秒"

echo "=== 解析依赖闭包 ==="
apt-get install -y --no-install-recommends --print-uris ffmpeg ca-certificates 2>/dev/null \
    | grep -o "'http[^']*'" | tr -d "'" > /tmp/uris.txt
echo "待下载 $(wc -l < /tmp/uris.txt) 个文件"

echo "=== 逐个下载（单文件 120s 超时，最多重试 3 次）==="
node -e '
const fs = require("node:fs");
const path = require("node:path");
const uris = fs.readFileSync("/tmp/uris.txt", "utf8").split(/\r?\n/).filter(Boolean);
const dir = "/debs";
(async () => {
    let ok = 0, fail = 0, bytes = 0;
    const started = Date.now();
    for (const [index, uri] of uris.entries()) {
        const name = decodeURIComponent(uri.split("/").pop());
        const dest = path.join(dir, name);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { ok += 1; continue; }
        let done = false;
        for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 120000);
            try {
                const response = await fetch(uri, { signal: controller.signal });
                if (!response.ok) throw new Error("HTTP " + response.status);
                const buffer = Buffer.from(await response.arrayBuffer());
                if (buffer.length === 0) throw new Error("empty body");
                fs.writeFileSync(dest + ".part", buffer);
                fs.renameSync(dest + ".part", dest);
                bytes += buffer.length;
                done = true;
            } catch (error) {
                if (attempt === 3) console.log("FAIL", name, error.name, error.message);
            } finally {
                clearTimeout(timer);
            }
        }
        if (done) ok += 1; else fail += 1;
        if ((index + 1) % 50 === 0) console.log(`  ${index + 1}/${uris.length} ok=${ok} fail=${fail} ${(bytes/1048576).toFixed(1)}MB`);
    }
    console.log(`完成 ok=${ok} fail=${fail} 共 ${(bytes/1048576).toFixed(1)}MB`);
    if (fail > 0) process.exitCode = 1;
})();
'

echo "=== 结果 ==="
ls "$DEBS"/*.deb 2>/dev/null | wc -l | sed 's/^/已下载 deb 数: /'
du -sh "$DEBS" 2>/dev/null
