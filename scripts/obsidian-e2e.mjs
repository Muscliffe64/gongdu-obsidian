// 起一个独立的 Obsidian（自己的用户数据目录，不碰平时用的库和设置），打开测试库，用 DevTools 协议一步步操作。
// 用法：node scripts/obsidian-e2e.mjs <放用户数据和截图的文件夹> <库的路径> <步骤.json>
// 步骤是一个数组，每步一种：
//   ["eval", "JS（可以 await，return 的值会打出来）", "标签"]
//   ["wait", 毫秒]  ["move", x, y]（移动鼠标）  ["shot", "文件名"]（截图存到第一个文件夹）
//   ["server", "共读网站的接口地址", "令牌", "r => 要打出来的部分"]
// 第一步一般是：if (!app.plugins.isEnabled()) app.plugins.setEnable(true); 然后等两个插件加载好。
// 可以把平时用的 ~/Library/Application Support/obsidian/obsidian-<版本>.asar 复制到用户数据文件夹，用同一个版本。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [S, V] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const USER = path.join(S, 'obs-user');
fs.writeFileSync(path.join(USER, 'obsidian.json'), JSON.stringify({ vaults: { e2e0000000000001: { path: V, ts: Date.now(), open: true } }, updateDisabled: true }));
const PORT = 9555;
const proc = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [`--user-data-dir=${USER}`, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 80 && !ws; i++) {
  await sleep(250);
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const p = t.find(x => x.type === 'page' && /index\.html/.test(x.url));
    if (p) ws = new WebSocket(p.webSocketDebuggerUrl);
  } catch {}
}
if (!ws) { console.log('no obsidian page'); proc.kill(); process.exit(1); }
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = m => { const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d); pend.delete(d.id); }
  else if (d.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(d.params.type.toUpperCase() + ' ' + d.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300)); };
const send = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value; };
for (let i = 0; i < 60; i++) { if (await ev('return typeof app !== "undefined" && !!app.workspace && app.workspace.layoutReady')) break; await sleep(500); }
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
for (const s of steps) {
  if (s[0] === 'wait') { await sleep(s[1]); continue; }
  if (s[0] === 'move') { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s[1], y: s[2] }); continue; }
  if (s[0] === 'shot') { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = path.join(S, s[1] + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); console.log('shot>', f); continue; }
  if (s[0] === 'server') { const r = await (await fetch(s[1], { headers: { Authorization: 'Bearer ' + s[2] } })).json(); console.log('server>', JSON.stringify(s[3] ? eval(s[3])(r) : r)); continue; }
  console.log((s[2] || 'eval') + '>', JSON.stringify(await ev(s[1])));
}
console.log(logs.length ? 'console>\n  ' + logs.join('\n  ') : 'console> clean');
ws.close(); proc.kill(); await sleep(500);
process.exit(0);
