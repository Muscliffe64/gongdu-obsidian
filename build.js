#!/usr/bin/env node
'use strict';
// 把 src/ 里的模块打成 Obsidian 要的一个 main.js。不用第三方工具：每个模块包成一个函数，require 自己接管 ./ 开头的。
// 用法：node build.js            → main.js
//       node build.js <库的路径>  → 另外装到这个库的 .obsidian/plugins/gongdu/（本机测试用）
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'src');
const names = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();
const parts = [
  "'use strict';",
  '// 由 build.js 生成，不要直接改。要改就改 src/ 里的文件，再运行 node build.js。',
  'const __mods = {};',
  'const __cache = {};',
  'function __req(name) {',
  "  if (!name.startsWith('./')) return require(name);",
  "  const key = name.replace(/\\.js$/, '');",
  '  if (__cache[key]) return __cache[key].exports;',
  "  if (!__mods[key]) throw new Error('共读打卡：找不到模块 ' + name);",
  '  const module = { exports: {} };',
  '  __cache[key] = module;',
  '  __mods[key](module, module.exports, __req);',
  '  return module.exports;',
  '}',
];
for (const f of names) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  parts.push(`__mods['./${f.replace(/\.js$/, '')}'] = function (module, exports, require) {\n${code}\n};`);
}
parts.push("module.exports = __req('./main');", '');
fs.writeFileSync(path.join(__dirname, 'main.js'), parts.join('\n'));
console.log(`main.js：${names.length} 个模块`);

const vault = process.argv[2];
if (vault) {
  const dest = path.join(vault, '.obsidian', 'plugins', 'gongdu');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['main.js', 'manifest.json', 'styles.css']) fs.copyFileSync(path.join(__dirname, f), path.join(dest, f));
  console.log(`装到了 ${dest}`);
}
