import { speech } from './speech.js';
export { GuestRoom, MatchArchive } from './room.js';
export { Lobby } from './lobby.js';
export { LocalSave } from './save.js';
export { GitBudget } from './git-budget.js';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const validCode = /^[A-HJ-NP-Z2-9]{4}$/;
const jsonError = (error, status) =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

async function page(req, env, file) {
  const url = new URL(req.url);
  url.pathname = '/' + file;
  url.search = '';
  const asset = await env.ASSETS.fetch(new Request(url, { method: req.method }));
  const res = new Response(asset.body, asset);
  res.headers.set('Cache-Control', 'no-cache');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' " +
      (url.protocol === 'https:' ? 'wss://' : 'ws://') +
      url.host +
      "; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return res;
}

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url),
        path = url.pathname;
      const origin = req.headers.get('Origin');
      if (
        (req.method === 'POST' || req.method === 'PUT' || path === '/ws') &&
        origin &&
        origin !== url.origin
      )
        return jsonError('请求来源不符', 403);
      const saveLookup = /^\/api\/saves\/[a-f0-9]{32}$/.test(path);
      if (saveLookup && !/^Bearer [a-f0-9]{64}$/.test(req.headers.get('Authorization') || ''))
        return jsonError('存档链接无效', 404);
      if (
        (saveLookup || path === '/ws') &&
        env.JOIN_LIMIT &&
        !(await env.JOIN_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') || 'local' })).success
      )
        return jsonError('请求过于频繁，请稍后重试', 429);
      if (path === '/api/rooms' || path === '/api/saves') {
        if (req.method !== 'POST') return jsonError('需要 POST', 405);
        if (
          env.CREATE_LIMIT &&
          !(await env.CREATE_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') || 'local' })).success
        )
          return jsonError('创建过于频繁，请稍后再试', 429);
      }
      if (path === '/api/rooms') {
        for (let i = 0; i < 8; i++) {
          const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => alphabet[n % 32]).join(
            '',
          );
          const headers = new Headers(req.headers);
          headers.set('x-room-code', code);
          const response = await env.ROOMS.getByName(code).fetch(url, { method: 'POST', headers });
          if (response.status !== 409) return response;
        }
        return jsonError('暂时无法创建房间，请再试', 503);
      }
      if (path === '/ws') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
          return jsonError('需要 WebSocket', 426);
        if (url.searchParams.has('party')) {
          const code = (url.searchParams.get('room') || '').toUpperCase();
          if (!validCode.test(code) || url.searchParams.get('party') !== 'phone')
            return jsonError('房间地址无效', 400);
          const headers = new Headers(req.headers);
          headers.set('x-room-code', code);
          return env.ROOMS.getByName(code).fetch(new Request(req, { headers }));
        }
        return env.LOBBY.getByName('online').fetch(req);
      }
      if (path === '/api/login' || path === '/api/register') return env.LOBBY.getByName('online').fetch(req);
      if (path === '/api/saves' || saveLookup) {
        const id =
          path === '/api/saves' ? crypto.randomUUID().replaceAll('-', '') : path.slice('/api/saves/'.length);
        const headers = new Headers(req.headers);
        headers.set('x-save-id', id);
        return env.SAVES.getByName(id).fetch(new Request(req, { headers }));
      }
      if (path === '/tts') return speech(req, env, ctx);
      if (path.startsWith('/api/')) return jsonError('没有这个接口', 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') return jsonError('需要 GET', 405);
      if (path === '/' || path === '/party') return page(req, env, 'index.html');
      if (path === '/local') return page(req, env, 'local.html');
      if (/^\/p\/[a-zA-Z2-9]{4}\/?$/.test(path)) return page(req, env, 'phone.html');
      if (path === '/online' || /^\/t\/[A-Za-z2-9]{6}\/?$/.test(path)) return page(req, env, 'online.html');
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error('Request failed', err.message);
      return jsonError('服务暂时不可用，请稍后重试', 503);
    }
  },
};
