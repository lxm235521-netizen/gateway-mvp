const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const jsonata = require('jsonata');
const { req_mapping } = require('../scripts/yuanai-image-4k-config');

// Exercise the actual multipart encoder without sending images to a paid API.
const filename = path.resolve(__dirname, '../server.js');
const nativeRequire = createRequire(filename);
const context = vm.createContext({
    require(name) { return name === './db' ? {} : nativeRequire(name); },
    module: { exports: {} }, __dirname: path.dirname(filename), process, console, Buffer, URL
});
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
const buildPostOptions = vm.runInContext('buildPostOptions', context);
const resolveUpstreamUrl = vm.runInContext('resolveUpstreamUrl', context);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const dataUrl = 'data:image/png;base64,' + png.toString('base64');

test('YuanAI single and multiple images become repeated image file parts', async () => {
    for (const count of [1, 2, 3]) {
        const mapped = await jsonata(req_mapping).evaluate({
            images: Array(count).fill(dataUrl), prompt: 'test', size: '16:9', n: 2, quality: 'medium'
        });
        const request = await buildPostOptions('test-key', mapped, 'bearer');
        const body = request.data.getBuffer();
        const text = body.toString('latin1');
        assert.equal(resolveUpstreamUrl({ base_url: 'https://yuanai.uk' }, mapped), 'https://yuanai.uk/v1/images/edits');
        assert.match(request.options.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.equal((text.match(/name="image"; filename="image-\d+"/g) || []).length, count);
        assert.equal((text.match(/Content-Type: image\/png/g) || []).length, count);
        assert.equal(text.split(png.toString('latin1')).length - 1, count);
        for (const [key, value] of Object.entries({ model: 'gpt-image-2', n: '2', quality: 'medium', size: '3840x2160', response_format: 'url' })) {
            assert.ok(text.includes(`name="${key}"\r\n\r\n${value}\r\n`), key);
        }
        assert.equal(text.includes('name="source"'), false);
    }
});

test('YuanAI empty images use JSON generation with existing size mappings', async () => {
    const sizes = { '16:9': '3840x2160', '9:16': '2160x3840', '1:1': '4096x4096', '4:3': '4096x3072', '3:4': '3072x4096' };
    for (const images of [undefined, [], ['']]) {
        for (const [size, expected] of Object.entries(sizes)) {
            const mapped = await jsonata(req_mapping).evaluate({ images, size, prompt: 'test' });
            const request = await buildPostOptions('test-key', mapped);
            assert.equal(resolveUpstreamUrl({ base_url: 'https://yuanai.uk' }, mapped), 'https://yuanai.uk/v1/images/generations');
            assert.deepEqual(JSON.parse(JSON.stringify(request.data)), {
                aspect_ratio: size, image_size: '4K', model: 'gpt-image-2', n: 1,
                prompt: 'test', quality: 'high', response_format: 'url', size: expected
            });
        }
    }
});
