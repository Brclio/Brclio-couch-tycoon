// 一个进程：静态文件 + 登录接口 + WebSocket（大厅、桌子、对局）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createGame, act, autoAct, current, publicView, RuleError } from './shared/engine.js';
import { getSpeech, ttsEnabled, warmCards } from './tts.js';
import { CARDS } from './shared/board.js';
import * as party from './party.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5200);
const DATA = path.join(ROOT, 'data', 'users.json');
const DISCONNECT_GRACE = 5 * 60_000;   // 断线 5 分钟算认输
const OFFLINE_TURN = 3_000;            // 掉线玩家的回合 3 秒后自动操作
const WAITING_GRACE = 60_000;          // 开局前掉线 1 分钟让出座位
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- 账号 ----------

let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
const saveDb = () => {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(db, null, 1));
};
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const userByToken = (token) => token && Object.values(db.users).find(u => u.tokens?.includes(token));
const publicUser = (u) => ({ id: u.id, name: u.name });

function issueToken(u) {
  const token = crypto.randomBytes(24).toString('hex');
  u.tokens = [token, ...(u.tokens || [])].slice(0, 5);
  saveDb();
  return token;
}

function register({ name, password }) {
  name = String(name || '').trim();
  if ([...name].length < 2 || [...name].length > 12) return { error: '昵称要 2–12 个字' };
  if (String(password || '').length < 4) return { error: '密码至少 4 位' };
  if (db.users[name]) return { error: '这个昵称已经有人用了' };
  const salt = crypto.randomBytes(16).toString('hex');
  const u = db.users[name] = { id: crypto.randomUUID(), name, salt, hash: hashPw(String(password), salt), tokens: [] };
  return { token: issueToken(u), user: publicUser(u) };
}

function login({ name, password }) {
  const u = db.users[String(name || '').trim()];
  if (!u || hashPw(String(password || ''), u.salt) !== u.hash) return { error: '昵称或密码不对' };
  return { token: issueToken(u), user: publicUser(u) };
}

// ---------- 桌子 ----------

const tables = new Map();      // id -> table
const userTable = new Map();   // userId -> tableId
const conns = new Map();       // userId -> Set<ws>
const offlineSince = new Map(); // userId -> 掉线时间

function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while ([...tables.values()].some(t => t.code === code));
  return code;
}

const ctx = () => ({ now: Date.now(), rng: Math.random });

function lobbyView() {
  return [...tables.values()]
    .filter(t => t.status === 'waiting')
    .map(t => ({
      id: t.id, name: t.name, host: t.seats.find(s => s.id === t.hostId)?.name,
      count: t.seats.length, max: t.max, locked: t.locked, duration: t.duration,
    }));
}

function tableView(t, uid) {
  return {
    id: t.id, name: t.name, hostId: t.hostId, max: t.max, locked: t.locked,
    duration: t.duration, status: t.status,
    code: t.seats.some(s => s.id === uid) ? t.code : null,
    seats: t.seats.map(s => ({ ...s, online: conns.has(s.id) })),
    game: t.game ? publicView(t.game) : null,
  };
}

function send(uid, msg) {
  const data = JSON.stringify(msg);
  for (const ws of conns.get(uid) || []) ws.send(data);
}

function broadcastLobby() {
  const msg = { t: 'lobby', tables: lobbyView() };
  for (const uid of conns.keys()) send(uid, msg);
}

function broadcastTable(t) {
  for (const s of t.seats) send(s.id, { t: 'table', table: tableView(t, s.id) });
}

function leaveTable(uid) {
  const t = tables.get(userTable.get(uid));
  userTable.delete(uid);
  if (!t) return;
  if (t.status === 'playing') {
    const p = t.game.players.find(p => p.id === uid);
    if (p && !p.bankrupt) {
      act(t.game, uid, { type: 'resign' }, ctx());
      if (t.game.status === 'ended') t.status = 'ended';
    }
  }
  t.seats = t.seats.filter(s => s.id !== uid);
  if (!t.seats.length) { tables.delete(t.id); return; }
  if (t.hostId === uid) t.hostId = t.seats[0].id;
  broadcastTable(t);
}

const handlers = {
  create(u, m) {
    if (userTable.has(u.id)) throw new RuleError('你已经在一张桌子上了');
    const max = Math.min(6, Math.max(2, Number(m.max) || 4));
    const duration = [0, 30, 60].includes(Number(m.duration)) ? Number(m.duration) : 60;
    const name = String(m.name || '').trim().slice(0, 16) || `${u.name}的桌子`;
    const t = {
      id: crypto.randomUUID(), code: newCode(), name, hostId: u.id, max, duration,
      locked: !!m.locked, status: 'waiting', game: null,
      seats: [{ id: u.id, name: u.name, ready: false }],
    };
    tables.set(t.id, t);
    userTable.set(u.id, t.id);
    broadcastTable(t);
  },

  join(u, m) {
    const code = String(m.code || '').trim().toUpperCase();
    const t = m.tableId ? tables.get(m.tableId) : [...tables.values()].find(t => t.code === code);
    if (!t) throw new RuleError(code ? '邀请码不对' : '桌子不存在了');
    if (userTable.get(u.id) === t.id) return broadcastTable(t);
    if (userTable.has(u.id)) throw new RuleError('你已经在一张桌子上了，先离开');
    if (t.status !== 'waiting') throw new RuleError('这桌已经开局了');
    if (t.seats.length >= t.max) throw new RuleError('这桌满了');
    if (t.locked && code !== t.code) throw new RuleError('这桌上锁了，需要邀请码');
    t.seats.push({ id: u.id, name: u.name, ready: false });
    userTable.set(u.id, t.id);
    broadcastTable(t);
  },

  leave(u) { leaveTable(u.id); send(u.id, { t: 'table', table: null }); },

  ready(u, m) {
    const t = myTable(u, 'waiting');
    t.seats.find(s => s.id === u.id).ready = !!m.v;
    broadcastTable(t);
  },

  lock(u, m) {
    const t = myTable(u, 'waiting', true);
    t.locked = !!m.v;
    broadcastTable(t);
  },

  start(u) {
    const t = myTable(u, 'waiting', true);
    if (t.seats.length < 2) throw new RuleError('至少要 2 个人');
    if (t.seats.some(s => s.id !== t.hostId && !s.ready)) throw new RuleError('还有人没准备');
    t.status = 'playing';
    t.game = createGame(t.seats, { durationMin: t.duration }, ctx());
    broadcastTable(t);
  },

  act(u, m) {
    const t = myTable(u, 'playing');
    act(t.game, u.id, m.action || {}, ctx());
    if (t.game.status === 'ended') t.status = 'ended';
    broadcastTable(t);
  },

  again(u) {
    const t = myTable(u, 'ended', true);
    t.status = 'waiting';
    t.game = null;
    t.seats.forEach(s => { s.ready = false; });
    broadcastTable(t);
  },
};

function myTable(u, status, hostOnly) {
  const t = tables.get(userTable.get(u.id));
  if (!t) throw new RuleError('你不在桌子上');
  if (status && t.status !== status) throw new RuleError('现在不能这样做');
  if (hostOnly && t.hostId !== u.id) throw new RuleError('只有房主可以这样做');
  return t;
}

// 计时：超时自动操作、掉线玩家快速跳过、掉线太久算认输
setInterval(() => {
  const now = Date.now();
  for (const t of [...tables.values()]) {
    if (t.status !== 'playing') {
      // 开局前或结束后掉线超过 1 分钟（不是刷新页面），让出座位
      const gone = t.seats.filter(s => now - (offlineSince.get(s.id) ?? now) > WAITING_GRACE);
      gone.forEach(s => leaveTable(s.id));
      if (gone.length) broadcastLobby();
      continue;
    }
    const g = t.game;
    let changed = false;
    for (const s of t.seats) {
      const since = offlineSince.get(s.id);
      const p = g.players.find(p => p.id === s.id);
      if (since && now - since > DISCONNECT_GRACE && p && !p.bankrupt && g.status === 'playing') {
        act(g, s.id, { type: 'resign' }, ctx());
        changed = true;
      }
    }
    if (g.status === 'playing') {
      const cur = current(g);
      const limit = conns.has(cur.id) ? g.deadline : g.deadline - 30_000 + OFFLINE_TURN;
      if (now >= limit) {
        if (process.env.DEBUG) console.log(new Date().toISOString().slice(11, 23), cur.name, 'auto', g.phase);
        autoAct(g, ctx()); changed = true;
      }
    }
    if (g.status === 'ended') t.status = 'ended';
    if (changed) broadcastTable(t);
  }
}, 500);

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.mp3': 'audio/mpeg' };

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'POST' && url.pathname === '/api/register') {
    const r = register(await readJson(req));
    if (!r.error) saveDb();
    return json(r, r.error ? 400 : 200);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const r = login(await readJson(req));
    return json(r, r.error ? 400 : 200);
  }
  // 语音播报：/tts?t=一句话 → Gemini 合成的 mp3（有缓存）
  if (url.pathname === '/tts') {
    const text = (url.searchParams.get('t') || '').trim();
    if (!ttsEnabled) return json({ error: '没有配置 GEMINI_API_KEY' }, 503);
    if (!text || text.length > 120) return json({ error: '文字为空或太长' }, 400);
    try {
      const file = await getSpeech(text);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=31536000' });
      return fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('tts', e.message);
      return json({ error: 'tts 失败' }, 502);
    }
  }
  if (url.pathname.startsWith('/shared/')) {
    return serveFile(res, path.join(ROOT, 'shared', path.basename(url.pathname)));
  }
  const rel = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(ROOT, 'public', rel);
  if (rel !== '/' && file.startsWith(path.join(ROOT, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return serveFile(res, file);
  }
  // /online 和 /t/邀请码 是在线大厅；/p/房间码 是聚会模式手机端；其他路径（含大屏 /party）都是试玩页
  const online = url.pathname === '/online' || url.pathname.startsWith('/t/');
  const phone = url.pathname.startsWith('/p/');
  serveFile(res, path.join(ROOT, 'public', online ? 'online.html' : phone ? 'phone.html' : 'index.html'));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.get('party')) return party.connect(ws, q);
  const token = q.get('token');
  const u = userByToken(token);
  if (!u) { ws.send(JSON.stringify({ t: 'auth', ok: false })); return ws.close(); }

  if (!conns.has(u.id)) conns.set(u.id, new Set());
  conns.get(u.id).add(ws);
  offlineSince.delete(u.id);

  const t = tables.get(userTable.get(u.id));
  ws.send(JSON.stringify({ t: 'auth', ok: true, user: publicUser(u) }));
  ws.send(JSON.stringify({ t: 'lobby', tables: lobbyView() }));
  ws.send(JSON.stringify({ t: 'table', table: t ? tableView(t, u.id) : null }));
  if (t) broadcastTable(t);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const h = handlers[m.t];
    if (!h) return;
    if (process.env.DEBUG) console.log(new Date().toISOString().slice(11, 23), u.name, JSON.stringify(m));
    try {
      h(u, m);
    } catch (e) {
      if (!(e instanceof RuleError)) console.error(e);
      ws.send(JSON.stringify({ t: 'error', msg: e instanceof RuleError ? e.message : '服务器出错了' }));
    }
    broadcastLobby();
  });

  ws.on('close', () => {
    const set = conns.get(u.id);
    set?.delete(ws);
    if (set && !set.size) {
      conns.delete(u.id);
      offlineSince.set(u.id, Date.now());
      const t = tables.get(userTable.get(u.id));
      if (t) broadcastTable(t);
    }
  });
});

// 监听所有网卡，同一个 Wi-Fi 下的手机才能连上
server.listen(PORT, '0.0.0.0', () => {
  party.setPort(PORT);
  console.log(`客厅大富翁 http://localhost:${PORT}`);
  console.log(`聚会模式大屏 http://localhost:${PORT}/party · 手机连 ${party.joinBase()}`);
  warmCards(CARDS);
});
