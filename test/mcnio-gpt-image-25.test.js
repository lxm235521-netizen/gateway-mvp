const test = require('node:test');
const assert = require('node:assert/strict');
const jsonata = require('jsonata');
const { channel, bindings, RATIOS, buildReqMapping } = require('../scripts/mcnio-gpt-image-25-config');

const upstream = {
    choices: [{
        message: {
            role: 'assistant',
            content: '![Generated Image](https://img.mcnio.com/generated/example.png)'
        }
    }]
};

function bindingFor(modelName) {
    return bindings.find(item => item.model_name === modelName);
}

async function mapRequest(modelName, body) {
    const mapped = await jsonata(bindingFor(modelName).req_mapping).evaluate({ model: modelName, ...body });
    return JSON.parse(JSON.stringify(mapped));
}

async function mapResponse(modelName, response) {
    const mapped = await jsonata(bindingFor(modelName).resp_mapping).evaluate(response);
    return JSON.parse(JSON.stringify(mapped));
}

test('MCNIO GPT Image 2.5 exposes the two tiered logical models on the shared channel', () => {
    assert.equal(channel.name, 'MCNIO GPT Image');
    assert.equal(channel.base_url, 'https://api.mcnio.com');
    assert.deepEqual(bindings.map(item => item.model_name), ['gpt-image-2.5-2k', 'gpt-image-2.5-4k']);
    for (const item of bindings) {
        assert.equal(item.route_path, '/v1/chat/completions');
        assert.equal(item.is_async, 0);
        assert.equal(item.proxy_content, 0);
    }
});

test('size maps to every upstream ratio and builds the fixed spec model name', async () => {
    for (const tier of ['2k', '4k']) {
        const modelName = `gpt-image-2.5-${tier}`;
        for (const ratio of RATIOS) {
            const colon = ratio.replace('x', ':');
            for (const size of [colon, ratio]) {
                const mapped = await mapRequest(modelName, { prompt: '城市夜景', size });
                assert.deepEqual(mapped, {
                    _route_path: '/v1/chat/completions',
                    model: `gpt-image-2.5-sunburst-${tier}-${ratio}`,
                    messages: [{ role: 'user', content: '城市夜景' }]
                });
            }
        }
    }
});

test('missing size falls back to 1x1 and unsupported ratios are normalized', async () => {
    assert.equal((await mapRequest('gpt-image-2.5-2k', { prompt: 'a' })).model, 'gpt-image-2.5-sunburst-2k-1x1');
    assert.equal((await mapRequest('gpt-image-2.5-2k', { prompt: 'a', size: '' })).model, 'gpt-image-2.5-sunburst-2k-1x1');
    assert.equal((await mapRequest('gpt-image-2.5-2k', { prompt: 'a', size: '32:9' })).model, 'gpt-image-2.5-sunburst-2k-32x9');
    assert.equal((await mapRequest('gpt-image-2.5-4k', { prompt: 'a', size: '16/9' })).model, 'gpt-image-2.5-sunburst-4k-16x9');
    assert.equal((await mapRequest('gpt-image-2.5-4k', { prompt: 'a', size: '16X9' })).model, 'gpt-image-2.5-sunburst-4k-16x9');
});

test('variant and full upstream names select Flare', async () => {
    assert.equal(
        (await mapRequest('gpt-image-2.5-2k', { prompt: 'a', size: '16:9', variant: 'flare' })).model,
        'gpt-image-2.5-flare-2k-16x9'
    );
    assert.equal(
        (await mapRequest('gpt-image-2.5-2k', { prompt: 'a', size: '16:9', variant: 'FLARE' })).model,
        'gpt-image-2.5-flare-2k-16x9'
    );
    assert.equal(
        (await mapRequest('gpt-image-2.5-4k', { prompt: 'a', size: '1:1', variant: 'sunburst' })).model,
        'gpt-image-2.5-sunburst-4k-1x1'
    );
    assert.equal(
        (await mapRequest('gpt-image-2.5-2k', { prompt: 'a', size: '1:1', variant: 'unexpected' })).model,
        'gpt-image-2.5-sunburst-2k-1x1'
    );
    assert.equal(
        (await mapRequest('gpt-image-2.5-4k', { prompt: 'a', model: 'gpt-image-2.5-flare-4k-9x16' })).model,
        'gpt-image-2.5-flare-4k-9x16'
    );
    assert.equal(
        (await mapRequest('gpt-image-2.5-2k', { prompt: 'a', model: 'gpt-image-2.5-sunburst-2k-21x9' })).model,
        'gpt-image-2.5-sunburst-2k-21x9'
    );
    // 完整名只提供变体与比例，分辨率档位始终跟随逻辑模型，不会串档。
    assert.equal(
        (await mapRequest('gpt-image-2.5-2k', { prompt: 'a', model: 'gpt-image-2.5-sunburst-4k-5x4' })).model,
        'gpt-image-2.5-sunburst-2k-5x4'
    );
    assert.equal(
        (await mapRequest('gpt-image-2.5-4k', { prompt: 'a', size: '2x3', model: 'gpt-image-2.5-flare-2k-16x9' })).model,
        'gpt-image-2.5-flare-4k-16x9'
    );
});

test('downstream template fields the upstream rejects are never forwarded', async () => {
    for (const tier of ['2k', '4k']) {
        const mapped = await mapRequest(`gpt-image-2.5-${tier}`, {
            prompt: 'a',
            size: '16:9',
            quality: 'high',
            n: 1,
            response_format: 'url',
            aspect_ratio: '16:9',
            resolution: tier,
            duration: 10
        });
        for (const key of ['quality', 'n', 'response_format', 'aspect_ratio', 'resolution', 'duration', 'size', 'width', 'height']) {
            assert.equal(Object.hasOwn(mapped, key), false, `unexpected upstream field: ${key}`);
        }
        assert.deepEqual(Object.keys(mapped).sort(), ['_route_path', 'messages', 'model']);
        assert.equal(mapped.messages.length, 1);
        assert.deepEqual(mapped.messages[0].role, 'user');
    }
});

test('image to image becomes one image_url part per reference image', async () => {
    const dataUrlA = 'data:image/png;base64,AAAA';
    const dataUrlB = 'data:image/webp;base64,BBBB';
    for (const count of [1, 3, 6]) {
        const images = count === 1
            ? [dataUrlA]
            : Array.from({ length: count }, (_, index) => index % 2 ? dataUrlB : dataUrlA);
        const mapped = await mapRequest('gpt-image-2.5-2k', { prompt: '保持主体一致', size: '9:16', images });
        assert.equal(mapped.messages[0].content.length, count + 1);
        assert.deepEqual(mapped.messages[0].content[0], { type: 'text', text: '保持主体一致' });
        const parts = mapped.messages[0].content.slice(1);
        assert.equal(parts.length, count);
        for (const [index, part] of parts.entries()) {
            assert.equal(part.type, 'image_url');
            assert.equal(part.image_url.url, images[index]);
        }
        assert.equal(mapped.model, 'gpt-image-2.5-sunburst-2k-9x16');
    }
});

test('empty reference image lists fall back to text-only generation', async () => {
    const textOnly = [undefined, [], [''], [null], [{ url: '' }]];
    for (const images of textOnly) {
        const mapped = await mapRequest('gpt-image-2.5-4k', { prompt: '静物', size: '4:3', images });
        assert.equal(mapped.messages[0].content, '静物');
        assert.equal(mapped.model, 'gpt-image-2.5-sunburst-4k-4x3');
    }
    const wrapped = await mapRequest('gpt-image-2.5-4k', {
        prompt: '静物',
        size: '4:3',
        images: [{ url: 'https://example.com/a.jpg' }, { url: '' }]
    });
    assert.deepEqual(wrapped.messages[0].content, [
        { type: 'text', text: '静物' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }
    ]);
    const single = await mapRequest('gpt-image-2.5-4k', { prompt: '静物', images: 'https://example.com/b.jpg' });
    assert.deepEqual(single.messages[0].content, [
        { type: 'text', text: '静物' },
        { type: 'image_url', image_url: { url: 'https://example.com/b.jpg' } }
    ]);
});

test('upstream markdown, bare URL and data URL responses normalize to a top level url', async () => {
    const markdown = await mapResponse('gpt-image-2.5-2k', upstream);
    assert.equal(markdown.url, 'https://img.mcnio.com/generated/example.png');
    assert.deepEqual(markdown.data, [{ url: 'https://img.mcnio.com/generated/example.png', b64_json: null }]);
    assert.equal(markdown.b64_json, null);

    const bare = await mapResponse('gpt-image-2.5-2k', {
        choices: [{ message: { content: 'https://img.mcnio.com/generated/bare.png' } }]
    });
    assert.equal(bare.url, 'https://img.mcnio.com/generated/bare.png');

    const base64 = await mapResponse('gpt-image-2.5-2k', {
        choices: [{ message: { content: 'data:image/png;base64,iVBORw0KGgo=' } }]
    });
    assert.equal(base64.url, 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(base64.b64_json, 'iVBORw0KGgo=');
});

test('upstream images API payloads still expose data[0].url', async () => {
    const mapped = await mapResponse('gpt-image-2.5-4k', { data: [{ url: 'https://img.mcnio.com/generated/openai-style.png' }] });
    assert.equal(mapped.url, 'https://img.mcnio.com/generated/openai-style.png');
    assert.deepEqual(mapped.data, [{ url: 'https://img.mcnio.com/generated/openai-style.png', b64_json: null }]);
});

test('request mapping is generated per tier', () => {
    assert.match(buildReqMapping('2k'), /gpt-image-2\.5-" & \$variant & "-2k-/);
    assert.match(buildReqMapping('4k'), /gpt-image-2\.5-" & \$variant & "-4k-/);
});
