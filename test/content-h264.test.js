// 校验 /content?format=h264 的按需转码支持中与编码/缓存相关的纯逻辑。
// 真正的 ffmpeg 转码链路由 tools/verify-aicreation-seedance-fast.js 在容器里端到端验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { __internal } = require('../server');

const { wantsH264, h264CachePaths, isBrowserPlayableCodec, isTranscodeError, extractImageBedUrl } = __internal;
const withQuery = query => ({ query });

test('only the documented format values request an H.264 rendition', () => {
    for (const value of ['h264', 'H264', ' h264 ', 'avc', 'avc1', 'mp4']) {
        assert.equal(wantsH264(withQuery({ format: value })), true, `format=${value}`);
    }
    for (const value of [undefined, '', 'hevc', 'original', 'mkv', 'h265', '0', 'false']) {
        assert.equal(wantsH264(withQuery({ format: value })), false, `format=${JSON.stringify(value)}`);
    }
    // 完全没有 query 时不能触发转码（默认行为与以前一致）。
    assert.equal(wantsH264({}), false);
    assert.equal(wantsH264({ query: {} }), false);
});

test('browser-playable codecs are recognized and HEVC is not', () => {
    for (const codec of ['h264', 'avc1', 'vp8', 'vp9', 'av1']) {
        assert.equal(isBrowserPlayableCodec(codec), true, codec);
    }
    // HEVC/H.265 是这次线上问题的根因：Chrome / Firefox 默认解不了。
    for (const codec of ['hevc', 'h265', 'mpeg4', 'theora', null, undefined, '']) {
        assert.equal(isBrowserPlayableCodec(codec), false, String(codec));
    }
});

test('transcode failures are distinguishable from upstream poll failures', () => {
    assert.equal(isTranscodeError(new Error('ffmpeg not found (ffmpeg); install it or set FFMPEG_PATH')), true);
    assert.equal(isTranscodeError(new Error('ffmpeg exited with 1: Invalid data found')), true);
    assert.equal(isTranscodeError(new Error('ffprobe timed out')), true);
    assert.equal(isTranscodeError(new Error('ffmpeg timed out after 600000ms')), true);
    const upstreamError = new Error('Upstream source request failed with 403');
    upstreamError.upstreamStatus = 403;
    assert.equal(isTranscodeError(upstreamError), true);
    assert.equal(isTranscodeError(new Error('Task not found')), false);
    assert.equal(isTranscodeError(new Error('Failed to poll upstream status')), false);
    assert.equal(isTranscodeError(undefined), false);
});

test('renditions are cached per task under the content cache directory', () => {
    const first = h264CachePaths('8451e57e-ce33-4be3-8a1b-a8366250c3a0');
    const second = h264CachePaths('8451e57e-ce33-4be3-8a1b-a8366250c3a0');
    const other = h264CachePaths('9c237a96-7a6c-4fae-a347-0deb2c3f3e5b');
    assert.deepEqual(first, second);
    assert.notEqual(first.result, other.result);
    assert.equal(path.extname(first.result), '.mp4');
    assert.equal(path.extname(first.part), '.mp4');
    assert.equal(path.dirname(first.result), path.dirname(first.part));
    assert.equal(path.dirname(first.result), path.dirname(other.result));
    // 任务号里的路径分隔符不能逃出缓存目录。
    const hostile = h264CachePaths('../../etc/passwd');
    assert.equal(path.dirname(hostile.result), path.dirname(first.result));
});

test('image bed responses are parsed whether the bed answers text or JSON', () => {
    // Zipline 带 x-zipline-no-json 时直接回纯文本 URL。
    assert.equal(extractImageBedUrl({ data: 'https://files.mmg.lat/u/abc123.png' }), 'https://files.mmg.lat/u/abc123.png');
    assert.equal(extractImageBedUrl({ data: '\n  https://files.mmg.lat/u/abc123.png \n' }), 'https://files.mmg.lat/u/abc123.png');
    // 不带该头时回 JSON：files[].url 是 Zipline 的形状。
    assert.equal(
        extractImageBedUrl({ data: { files: [{ id: 'x', name: 'a.png', type: 'image/png', url: 'https://files.mmg.lat/u/json1.png' }], quota: { remaining: 9 } } }),
        'https://files.mmg.lat/u/json1.png'
    );
    // 其他后端把链接放在顶层 url 也要能认。
    assert.equal(extractImageBedUrl({ data: { url: 'https://other.example/u/1.png' } }), 'https://other.example/u/1.png');
    // 字符串里包着 JSON 的变体。
    assert.equal(extractImageBedUrl({ data: '{"files":[{"url":"https://files.mmg.lat/u/nested.png"}]}' }), 'https://files.mmg.lat/u/nested.png');
    // 解析不出链接时必须返回 null，让调用方按上传失败处理（而不是把垃圾写进请求体）。
    assert.equal(extractImageBedUrl({ data: 'upload rejected' }), null);
    assert.equal(extractImageBedUrl({ data: { files: [] } }), null);
    assert.equal(extractImageBedUrl({ data: { url: '   ' } }), null);
    assert.equal(extractImageBedUrl({ data: 42 }), null);
    assert.equal(extractImageBedUrl(null), null);
    assert.equal(extractImageBedUrl(undefined), null);
});
