'use strict';
// 连接共读：网站上点「连接 Obsidian」后，用 obsidian://gongdu-connect?server=…&code=… 打开这里；
// 或者学生在设置里手动输入连接码。连接码用一次就作废，换到的令牌存进插件设置。
// 这一块不需要 Obsidian，测试里直接用。

/** 共读网站地址：只收 https，本机测试的 http://localhost / 127.0.0.1 也收。返回去掉末尾斜杠的地址，不对就是 null。 */
function cleanServer(s) {
  let u;
  try { u = new URL(String(s || '').trim()); } catch { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

/** 连接码：去掉空格和横线、转大写，8 位。不对就是 null。 */
function cleanCode(s) {
  const c = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

/** 用连接码换令牌。返回 { token, name, class_name }；出错时抛出带中文说明的 Error。 */
async function exchange({ server, code, request }) {
  const base = cleanServer(server);
  if (!base) throw new Error('共读网站的地址不对');
  const c = cleanCode(code);
  if (!c) throw new Error('连接码是 8 位字母和数字，像 K7QM-2XPA');
  let res;
  try {
    res = await request({ url: base + '/api/agent/connect', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) });
  } catch {
    throw new Error('连不上共读网站');
  }
  const json = res && res.json && typeof res.json === 'object' ? res.json : {};
  if (!res || res.status !== 200 || typeof json.token !== 'string') throw new Error(json.message || `共读网站出错了（${res ? res.status : 0}）`);
  return { base, token: json.token, name: String(json.name || ''), class_name: String(json.class_name || '') };
}

module.exports = { cleanServer, cleanCode, exchange };
