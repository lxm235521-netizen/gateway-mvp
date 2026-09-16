"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    extractPrompt,
    applyOptimizedPrompt,
    parseOptimizerResponse,
    buildContentParts,
    validateMedia,
    parseInlineMode
} = require("../prompt-optimizer");

const IMAGE_URL = "https://cdn.example.com/a.png";
const IMAGE_DATA_URL = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");
const VIDEO_URL = "https://cdn.example.com/v.mp4";
const AUDIO_URL = "data:audio/mpeg;base64," + Buffer.from("fake-mp3-bytes").toString("base64");

function makeDataUrl(bytes) {
    return "data:image/png;base64," + Buffer.alloc(bytes).toString("base64");
}

// Builds the OpenAI-shaped response the optimizer service returns.
function chatResponse(content) {
    return { choices: [{ index: 0, message: { role: "assistant", content } }] };
}

// Regression: the live service sometimes wraps the prompt in a Chinese heading
// plus a markdown fence. Only the prompt body may reach the upstream model.
test("parseOptimizerResponse: unwraps a labelled markdown fence", () => {
    const body = "integrated_multimodal_description: [Shot 1] Live-action, cinematic, a man opens the door.";
    const wrapped = "## H3 提示词（T2VA）\n\n```text\n" + body + "\n```\n";
    assert.equal(parseOptimizerResponse(chatResponse(wrapped)), body);
});

test("parseOptimizerResponse: drops a leading label line without a fence", () => {
    const body = "integrated_multimodal_description: [Shot 1] A bakery at dawn.";
    assert.equal(parseOptimizerResponse(chatResponse("改写结果：\n" + body)), body);
    assert.equal(parseOptimizerResponse(chatResponse("说明：\n\n" + body)), body);
});

test("parseOptimizerResponse: keeps a plain prompt untouched and ignores inline code", () => {
    const body = "integrated_multimodal_description: [Shot 1] Plain prompt with no wrapper.";
    assert.equal(parseOptimizerResponse(chatResponse(body)), body);
    // A one-word inline example must not replace the surrounding prompt.
    const withInline = "integrated_multimodal_description: [Shot 1] Use `<d>[Chinese] 台词</d>` for dialogue.";
    assert.equal(parseOptimizerResponse(chatResponse(withInline)), withInline);
});

test("extractPrompt: text-only video payload round-trip", () => {
    const payload = { model: "veo-3", prompt: "a cat surfing a wave" };
    const extracted = extractPrompt(payload);

    assert.equal(extracted.prompt, "a cat surfing a wave");
    assert.equal(extracted.text, "a cat surfing a wave");
    assert.deepEqual(extracted.textPath, ["prompt"]);
    assert.deepEqual(extracted.media, []);

    const applied = applyOptimizedPrompt(payload, "a cinematic cat surfing a wave");
    assert.equal(applied.prompt, "a cinematic cat surfing a wave");
    assert.equal(applied.model, "veo-3");
    assert.equal(payload.prompt, "a cat surfing a wave");
});

test("extractPrompt: guards non-object payloads", () => {
    for (const bad of [null, undefined, "prompt", 42, [], true]) {
        const extracted = extractPrompt(bad);
        assert.deepEqual(extracted, { prompt: null, text: null, textPath: null, media: [] });
    }
});

test("extractPrompt: top-level field priority and string-only acceptance", () => {
    assert.equal(extractPrompt({ prompt: "p", text: "t" }).prompt, "p");
    assert.equal(extractPrompt({ input: "i", description: "d" }).prompt, "i");
    assert.equal(extractPrompt({ text: "t", query: "q" }).prompt, "t");
    assert.equal(extractPrompt({ prompt: { nested: "x" }, text: "fallback" }).prompt, "fallback");
    assert.equal(extractPrompt({ prompt: ["x"], text: "fallback" }).prompt, "fallback");
    assert.equal(extractPrompt({ prompt: "   ", text: "fallback" }).prompt, "fallback");
    assert.equal(extractPrompt({ model: "x" }).prompt, null);
    assert.equal(extractPrompt({ model: "x" }).textPath, null);
});

test("extractPrompt: chat payload with string content", () => {
    const payload = {
        model: "gpt-4o",
        prompt: "top-level should lose",
        messages: [
            { role: "system", content: "you are helpful" },
            { role: "user", content: "draw a red fox" }
        ]
    };
    const extracted = extractPrompt(payload);

    assert.equal(extracted.prompt, "draw a red fox");
    assert.deepEqual(extracted.textPath, ["messages", 1, "content"]);
    assert.deepEqual(extracted.media, []);
});

test("extractPrompt: chat payload parts-array content and media parts", () => {
    const payload = {
        model: "gpt-4o",
        messages: [
            { role: "system", content: "sys" },
            {
                role: "user",
                content: [
                    { type: "image_url", image_url: { url: IMAGE_URL } },
                    { type: "text", text: "describe this frame" }
                ]
            }
        ]
    };
    const extracted = extractPrompt(payload);

    assert.equal(extracted.prompt, "describe this frame");
    assert.deepEqual(extracted.textPath, ["messages", 1, "content", 1, "text"]);
    assert.deepEqual(extracted.media, [
        { path: "messages[1].content[0].image_url.url", kind: "image", url: IMAGE_URL }
    ]);
});

test("extractPrompt: last user message wins, system messages are ignored", () => {
    const payload = {
        messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "sure" },
            { role: "user", content: "second" }
        ]
    };
    const extracted = extractPrompt(payload);

    assert.equal(extracted.prompt, "second");
    assert.deepEqual(extracted.textPath, ["messages", 2, "content"]);
});

test("extractPrompt: image_url string form on a content part", () => {
    const payload = {
        messages: [{ role: "user", content: [{ type: "image_url", image_url: IMAGE_URL }] }]
    };
    const extracted = extractPrompt(payload);

    assert.deepEqual(extracted.media, [
        { path: "messages[0].content[0].image_url", kind: "image", url: IMAGE_URL }
    ]);
});

test("extractPrompt: nested media shapes and image values never become the prompt", () => {
    const payload = {
        prompt: "keep me",
        images: [{ url: IMAGE_URL }, { url: IMAGE_DATA_URL }],
        reference_images: [IMAGE_URL]
    };
    const extracted = extractPrompt(payload);

    assert.equal(extracted.prompt, "keep me");
    assert.deepEqual(extracted.media, [
        { path: "images[0].url", kind: "image", url: IMAGE_URL },
        { path: "images[1].url", kind: "image", url: IMAGE_DATA_URL },
        { path: "reference_images[0]", kind: "image", url: IMAGE_URL }
    ]);

    const noPrompt = extractPrompt({ images: [IMAGE_URL] });
    assert.equal(noPrompt.prompt, null);
    assert.equal(noPrompt.textPath, null);
    assert.deepEqual(noPrompt.media, [{ path: "images[0]", kind: "image", url: IMAGE_URL }]);
});

test("extractPrompt: media kinds from video/audio/frame keys", () => {
    const payload = {
        prompt: "p",
        video_url: VIDEO_URL,
        audio_url: AUDIO_URL,
        first_frame: "https://cdn.example.com/first.png",
        last_frame_image: { url: "data:image/jpeg;base64," + Buffer.from("x").toString("base64") }
    };
    const extracted = extractPrompt(payload);

    assert.deepEqual(
        extracted.media.map((item) => [item.path, item.kind]),
        [
            ["video_url", "video"],
            ["audio_url", "audio"],
            ["first_frame", "image"],
            ["last_frame_image.url", "image"]
        ]
    );
});

test("extractPrompt: unusable asset values are skipped", () => {
    const payload = {
        prompt: "p",
        images: ["not a url", "", 42, null, { url: "ftp://example.com/a.png" }, { data: "short" }]
    };
    assert.deepEqual(extractPrompt(payload).media, []);
});

test("extractPrompt: raw base64 under a base64-ish image key is usable", () => {
    const raw = "A".repeat(80);
    const extracted = extractPrompt({ image: raw });

    assert.deepEqual(extracted.media, [{ path: "image", kind: "image", url: raw }]);
    assert.equal(extracted.prompt, null);
});

test("applyOptimizedPrompt: strips an HTML comment trailer without mutating input", () => {
    const payload = {
        model: "veo-3",
        prompt: "old prompt <!-- meta: {\"mode\":\"I2VA\"} -->",
        options: { seed: 7, nested: { sizes: [1, 2, 3] } }
    };
    const snapshot = JSON.parse(JSON.stringify(payload));

    const applied = applyOptimizedPrompt(payload, "new prompt\n<!-- optimizer: v2\n   more meta -->\n");

    assert.equal(applied.prompt, "new prompt");
    assert.deepEqual(payload, snapshot);
    assert.notEqual(applied, payload);
    assert.deepEqual(applied.options, snapshot.options);
    assert.notEqual(applied.options, payload.options);
    assert.notEqual(applied.options.nested, payload.options.nested);
});

test("applyOptimizedPrompt: rewrites a text part inside messages and keeps siblings", () => {
    const payload = {
        model: "gpt-4o",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "old" },
                    { type: "image_url", image_url: { url: IMAGE_URL } }
                ]
            }
        ]
    };
    const applied = applyOptimizedPrompt(payload, "  optimized text  ");

    assert.equal(applied.messages[0].content[0].text, "optimized text");
    assert.equal(applied.messages[0].content[0].type, "text");
    assert.deepEqual(applied.messages[0].content[1], { type: "image_url", image_url: { url: IMAGE_URL } });
    assert.equal(payload.messages[0].content[0].text, "old");
});

test("applyOptimizedPrompt: empty or unusable results leave the clone unchanged", () => {
    const payload = { prompt: "old" };

    assert.equal(applyOptimizedPrompt(payload, "<!-- only a comment -->").prompt, "old");
    assert.equal(applyOptimizedPrompt(payload, "   \n  ").prompt, "old");
    assert.equal(applyOptimizedPrompt(payload, null).prompt, "old");
    assert.equal(applyOptimizedPrompt({ model: "x" }, "new").model, "x");
    assert.deepEqual(applyOptimizedPrompt({ model: "x" }, "new"), { model: "x" });
    assert.equal(applyOptimizedPrompt(null, "new"), null);
    assert.equal(payload.prompt, "old");
});

test("parseOptimizerResponse: plain text with an HTML comment trailer", () => {
    const data = { choices: [{ message: { content: "optimized plain text\n<!-- meta: 1 -->" } }] };
    assert.equal(parseOptimizerResponse(data), "optimized plain text");
});

test("parseOptimizerResponse: fenced JSON containing prompt", () => {
    const fenced = '```json\n{"prompt": "fenced prompt"}\n```';
    assert.equal(parseOptimizerResponse({ choices: [{ message: { content: fenced } }] }), "fenced prompt");
    const bare = "```\noptimized without language\n```";
    assert.equal(parseOptimizerResponse({ choices: [{ message: { content: bare } }] }), "optimized without language");
});

test("parseOptimizerResponse: bare JSON with alternate field names", () => {
    const wrap = (content) => ({ choices: [{ message: { content } }] });

    assert.equal(parseOptimizerResponse(wrap('{"optimized_prompt": "via optimized"}')), "via optimized");
    assert.equal(parseOptimizerResponse(wrap('{"rewritten_prompt": "via rewritten"}')), "via rewritten");
    assert.equal(parseOptimizerResponse(wrap('{"text": "via text"}')), "via text");
    assert.equal(parseOptimizerResponse(wrap('{"prompt": "  via prompt  "}')), "via prompt");
    assert.equal(parseOptimizerResponse(wrap('{"optimized_prompt": "op", "prompt": "p"}')), "p");
});

test("parseOptimizerResponse: malformed and garbage input returns null", () => {
    const cases = [
        null,
        undefined,
        "not an object",
        42,
        {},
        { choices: [] },
        { choices: "nope" },
        { choices: [null] },
        { choices: [{}] },
        { choices: [{ message: null }] },
        { choices: [{ message: { content: null } }] },
        { choices: [{ message: { content: 123 } }] },
        { choices: [{ message: { content: "   " } }] },
        { choices: [{ message: { content: '{"foo": 1}' } }] },
        { choices: [{ message: { content: '{"prompt": 5}' } }] }
    ];
    for (const bad of cases) {
        assert.equal(parseOptimizerResponse(bad), null, JSON.stringify(bad));
    }
});

test("buildContentParts: images, dedupe and prompt-less input", () => {
    const media = [
        { path: "images[0]", kind: "image", url: IMAGE_URL },
        { path: "images[1]", kind: "image", url: IMAGE_DATA_URL },
        { path: "images[2]", kind: "image", url: IMAGE_URL },
        { path: "images[3]", kind: "video", url: VIDEO_URL }
    ];

    assert.deepEqual(buildContentParts("draw a fox", media, "image"), [
        { type: "text", text: "draw a fox" },
        { type: "image_url", image_url: { url: IMAGE_URL } },
        { type: "image_url", image_url: { url: IMAGE_DATA_URL } }
    ]);

    assert.deepEqual(buildContentParts("", media, "image"), [
        { type: "image_url", image_url: { url: IMAGE_URL } },
        { type: "image_url", image_url: { url: IMAGE_DATA_URL } }
    ]);

    assert.deepEqual(buildContentParts("watch", media, "video"), [
        { type: "text", text: "watch" },
        { type: "video_url", video_url: { url: VIDEO_URL } }
    ]);

    assert.deepEqual(buildContentParts("listen", [{ kind: "audio", url: AUDIO_URL }], "audio"), [
        { type: "text", text: "listen" },
        { type: "input_audio", input_audio: { data: AUDIO_URL } }
    ]);

    assert.deepEqual(buildContentParts("only text", null, "image"), [{ type: "text", text: "only text" }]);
    assert.deepEqual(buildContentParts("no match", media, "audio"), [{ type: "text", text: "no match" }]);
});

test("validateMedia: partitions items and accepts defaults", () => {
    const media = [
        { path: "images[0]", kind: "image", url: IMAGE_URL },
        { path: "video_url", kind: "video", url: VIDEO_URL },
        { path: "audio_url", kind: "audio", url: AUDIO_URL }
    ];
    const result = validateMedia(media);

    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.deepEqual(result.images, [media[0]]);
    assert.deepEqual(result.videos, [media[1]]);
    assert.deepEqual(result.audios, [media[2]]);
});

test("validateMedia: over-limit counts fail with a readable reason", () => {
    const images = Array.from({ length: 10 }, (unused, i) => ({
        path: `images[${i}]`,
        kind: "image",
        url: IMAGE_URL
    }));
    const imagesOk = images.slice(0, 9);
    assert.equal(validateMedia(imagesOk).ok, true);

    const tooManyImages = validateMedia(images);
    assert.equal(tooManyImages.ok, false);
    assert.match(tooManyImages.reason, /图片数量超过上限 9/);

    const tooManyVideos = validateMedia(
        Array.from({ length: 4 }, (unused, i) => ({ path: `videos[${i}]`, kind: "video", url: VIDEO_URL }))
    );
    assert.equal(tooManyVideos.ok, false);
    assert.match(tooManyVideos.reason, /视频数量超过上限 3/);

    const tooManyAudios = validateMedia(
        Array.from({ length: 2 }, (unused, i) => ({ path: `audios[${i}]`, kind: "audio", url: AUDIO_URL })),
        { maxAudios: 1 }
    );
    assert.equal(tooManyAudios.ok, false);
    assert.match(tooManyAudios.reason, /音频数量超过上限/);
});

test("validateMedia: oversized data URL is rejected at the exact byte boundary", () => {
    const limits = { maxDataUrlBytes: 1000 };
    const atLimit = { kind: "image", url: makeDataUrl(1000) };
    const overLimit = { kind: "image", url: makeDataUrl(1001) };

    assert.equal(validateMedia([atLimit], limits).ok, true);

    const failed = validateMedia([overLimit], limits);
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /超过/);

    const defaultLimits = validateMedia([{ kind: "image", url: makeDataUrl(8 * 1024 * 1024 + 1) }]);
    assert.equal(defaultLimits.ok, false);
    assert.match(defaultLimits.reason, /单张图片超过 8MB 限制/);
});

test("validateMedia: bad URL is rejected and malformed input is tolerated", () => {
    for (const url of ["ftp://example.com/a.png", "not-a-url", "", null]) {
        const result = validateMedia([{ path: "images[0]", kind: "image", url }]);
        assert.equal(result.ok, false, String(url));
        assert.match(result.reason, /图片地址不是合法的 http\(s\) 或 data URL/);
    }

    for (const bad of [null, undefined, "images", 42, {}]) {
        const result = validateMedia(bad);
        assert.equal(result.ok, true);
        assert.equal(result.reason, null);
        assert.deepEqual(result.images, []);
        assert.deepEqual(result.videos, []);
        assert.deepEqual(result.audios, []);
    }

    assert.equal(validateMedia([null, 42, "x"]).ok, true);
});

test("parseInlineMode: each supported spelling", () => {
    assert.deepEqual(parseInlineMode("mode:Ref2VA a cat on a beach"), {
        mode: "Ref2VA",
        text: "a cat on a beach"
    });
    assert.deepEqual(parseInlineMode("模式=FL2VA 一只猫在海滩"), {
        mode: "FL2VA",
        text: "一只猫在海滩"
    });
    assert.deepEqual(parseInlineMode("--mode I2VA a dog"), { mode: "I2VA", text: "a dog" });
    assert.deepEqual(parseInlineMode("--mode=L2VA  a   dog"), { mode: "L2VA", text: "a dog" });
    assert.deepEqual(parseInlineMode("MODE:t2va   sunrise   timelapse"), {
        mode: "T2VA",
        text: "sunrise timelapse"
    });
    assert.deepEqual(parseInlineMode("画一只猫 mode:ref2va"), { mode: "Ref2VA", text: "画一只猫" });
});

test("parseInlineMode: no marker, unknown marker and non-string input", () => {
    assert.deepEqual(parseInlineMode("  a   plain   prompt  "), { mode: null, text: "a plain prompt" });
    assert.deepEqual(parseInlineMode("mode:XYZ a cat"), { mode: null, text: "mode:XYZ a cat" });
    assert.deepEqual(parseInlineMode("a cat"), { mode: null, text: "a cat" });
    assert.deepEqual(parseInlineMode(""), { mode: null, text: "" });
    assert.deepEqual(parseInlineMode(null), { mode: null, text: "" });
    assert.deepEqual(parseInlineMode(undefined), { mode: null, text: "" });
    assert.deepEqual(parseInlineMode(42), { mode: null, text: "" });
});

test("end-to-end: inline mode + optimize + apply + validate + content parts", () => {
    const inline = parseInlineMode("mode:I2VA 一只猫在沙滩上奔跑");
    assert.equal(inline.mode, "I2VA");

    const payload = {
        model: "veo-3",
        prompt: inline.text,
        images: [{ url: IMAGE_URL }]
    };
    const extracted = extractPrompt(payload);
    assert.equal(extracted.prompt, "一只猫在沙滩上奔跑");
    assert.equal(validateMedia(extracted.media).ok, true);

    const optimized = parseOptimizerResponse({
        choices: [{ message: { content: '```json\n{"prompt": "一只猫在夕阳下的沙滩上奔跑"}\n```' } }]
    });
    assert.equal(optimized, "一只猫在夕阳下的沙滩上奔跑");

    const applied = applyOptimizedPrompt(payload, optimized);
    assert.equal(applied.prompt, "一只猫在夕阳下的沙滩上奔跑");
    assert.equal(payload.prompt, "一只猫在沙滩上奔跑");
    assert.deepEqual(buildContentParts(applied.prompt, extracted.media, "image"), [
        { type: "text", text: "一只猫在夕阳下的沙滩上奔跑" },
        { type: "image_url", image_url: { url: IMAGE_URL } }
    ]);
});
