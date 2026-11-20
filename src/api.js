'use strict';
// 共读网站的智能体接口（请求头 Authorization: Bearer <令牌>）。
// request({ url, method, headers, body }) → { status, json }，由调用方提供：Obsidian 里用 requestUrl，测试里用 fetch。

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createApi({ base, token, request }) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  async function call(method, path, body) {
    if (!root) throw new ApiError(0, 'no_base', '还没有填共读网站的地址');
    if (!token) throw new ApiError(0, 'no_token', '还没有填共读令牌');
    let res;
    try {
      res = await request({
        url: root + path, method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, 'network', '连不上共读网站');
    }
    const json = res && res.json && typeof res.json === 'object' ? res.json : null;
    if (!res || res.status < 200 || res.status >= 300) {
      const status = res ? res.status : 0;
      const message = (json && json.message) || (status === 401 ? '令牌无效' : `共读网站出错了（${status}）`);
      throw new ApiError(status, (json && json.error) || 'http_' + status, message);
    }
    return json || {};
  }
  return {
    status: () => call('GET', '/api/agent/status'),
    checkin: body => call('POST', '/api/agent/checkin', body),
    uploadCover: (bookId, { mime, data, replace = false }) => call('POST', `/api/agent/books/${encodeURIComponent(bookId)}/cover`, { mime, data, replace }),
  };
}

module.exports = { createApi, ApiError };
