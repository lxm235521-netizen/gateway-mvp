// 把保存的 HTML 文档转成纯文本（只处理 MiniMax H3 相关内容），避免在 shell 里跟编码/引号搏斗。
const fs = require('fs');

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');

let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|pre)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');

console.log(`plain text chars: ${text.length}`);
console.log('--- first 200 lines ---');
console.log(text.split('\n').slice(0, 200).join('\n'));

if (process.argv[3] === '--save') {
    fs.writeFileSync(process.argv[4], text, 'utf8');
    console.log(`\nsaved to ${process.argv[4]}`);
}
