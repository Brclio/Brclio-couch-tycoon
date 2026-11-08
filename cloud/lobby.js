import { act, autoAct, createGame, current, publicView, RuleError } from '../shared/engine.js';
import { TURN_SECONDS } from '../shared/board.js';
import { GitHubState } from './storage.js';
import { deliverArchive } from './matches.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DISCONNECT_GRACE = 5 * 60_000;
const WAITING_GRACE = 60_000;
const OFFLINE_TURN = 3_000;
const SESSION_LIMIT = 5;
const PASSWORD_ROUNDS = 100_000;
const encoder = new TextEncoder();
const gameContext = (now = Date.now()) => ({ now, rng: Math.random });
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const publicUser = ({ id, name }) => ({ id, name });
const reject = message => { throw new RuleError(message); };
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function digest(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(salt.match(/../g), pair => parseInt(pair, 16)),
    iterations: PASSWORD_ROUNDS,
  }, key, 256);
  return hex(new Uint8Array(bits));
}

function matchesHash(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function credentials(req) {
  if (!req.body) reject('请输入昵称和密码');
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4096) {
      await reader.cancel();
      reject('请求过大');
    }
    text += decoder.decode(value, { stream: true });
  }
  let body;
  try { body = JSON.parse(text + decoder.decode()); } catch { reject('请求不是有效的 JSON'); }
  if (typeof body?.name !== 'string' || typeof body.password !== 'string') reject('请输入昵称和密码');
  const name = body.name.trim();
  if ([...name].length < 2 || [...name].length > 12) reject('昵称要 2–12 个字');
  if (body.password.length < 4 || body.password.length > 1024) reject('密码需要 4–1024 个字符');
  return { name, password: body.password };
}

function newCode(tables) {
  let code;
  do {
    code = Array.from(randomBytes(6), n => CODE_CHARS[n % CODE_CHARS.length]).join('');
  } while (tables.some(table => table.code === code));
  return code;
}

function lobbyView(tables) {
  return tables.filter(t => t.status === 'waiting').map(t => ({
    id: t.id, name: t.name, host: t.seats.find(s => s.id === t.hostId)?.name,
    max: t.max, count: t.seats.length, locked: t.locked, duration: t.duration,
  }));
}

function createTable(tables, user, message) {
  const max = Math.trunc(Number(message.max)) || 4;
  const duration = Number(message.duration);
  return {
    id: crypto.randomUUID(), code: newCode(tables),
    name: String(message.name || '').trim().slice(0, 16) || user.name + '的桌子',
    max: Math.max(2, Math.min(6, max)), duration: [0, 30, 60].includes(duration) ? duration : 60,
    locked: !!message.locked, hostId: user.id, status: 'waiting', game: null,
    seats: [{ ...publicUser(user), ready: false, offlineSince: null }],
  };
}

function leave(table, uid, now) {
  if (table.status === 'playing') {
    const p = table.game.players.find(p => p.id === uid);
    if (p && !p.bankrupt) act(table.game, uid, { type: 'resign' }, gameContext(now));
    table.status = table.game.status;
  }
  table.seats = table.seats.filter(s => s.id !== uid);
  if (table.hostId === uid) table.hostId = table.seats[0]?.id;
}

function tableAction(table, user, message) {
  const hostOnly = ['lock', 'start', 'again'];
  if (hostOnly.includes(message.t) && table.hostId !== user.id) reject('只有房主可以这样做');
  if (message.t === 'leave') return leave(table, user.id, Date.now());
  if (message.t === 'act') {
    if (table.status !== 'playing') reject('对局没在进行');
    const action = message.action;
    if (!action || typeof action.type !== 'string') reject('游戏动作不正确');
    if (message.seq != null && message.seq !== table.game.seq) reject('局面已更新，请再试一次');
    act(table.game, user.id, action, gameContext());
    table.status = table.game.status;
    return;
  }
  if (message.t === 'again') {
    if (table.status !== 'ended') reject('对局还没结束');
    table.status = 'waiting';
    table.game = null;
    table.seats.forEach(s => { s.ready = false; });
    return;
  }
  if (table.status !== 'waiting') reject('现在不能这样做');
  if (message.t === 'ready') table.seats.find(s => s.id === user.id).ready = !!message.v;
  else if (message.t === 'lock') table.locked = !!message.v;
  else if (message.t === 'start') {
    if (table.seats.length < 2) reject('至少要 2 个人');
    if (table.seats.some(s => s.id !== user.id && !s.ready)) reject('还有人没准备');
    table.game = createGame(table.seats, { durationMin: table.duration }, gameContext());
    table.matchId = crypto.randomUUID();
    table.finishedAt = null;
    table.status = 'playing';
  } else reject('未知操作');
}

function turnDeadline(table) {
  const seat = table.seats.find(s => s.id === current(table.game).id);
  const limit = table.game.deadline;
  return seat?.offlineSince == null ? limit : limit - TURN_SECONDS * 1000 + OFFLINE_TURN;
}

function nextTableDeadline(table) {
  let next = table.status === 'playing' ? turnDeadline(table) : Infinity;
  for (const seat of table.seats) {
    if (seat.offlineSince == null) continue;
    if (table.status !== 'playing') next = Math.min(next, seat.offlineSince + WAITING_GRACE);
    else if (!table.game.players.find(p => p.id === seat.id)?.bankrupt) {
      next = Math.min(next, seat.offlineSince + DISCONNECT_GRACE);
    }
  }
  return next;
}

function advanceTable(table, now) {
  for (const seat of [...table.seats]) {
    if (seat.offlineSince == null) continue;
    const elapsed = now - seat.offlineSince;
    if (table.status !== 'playing') {
      if (elapsed >= WAITING_GRACE) leave(table, seat.id, now);
    } else if (elapsed >= DISCONNECT_GRACE && !table.game.players.find(p => p.id === seat.id)?.bankrupt) {
      act(table.game, seat.id, { type: 'resign' }, gameContext(now));
      table.status = table.game.status;
    }
  }
  if (table.status === 'playing' && now >= turnDeadline(table)) {
    autoAct(table.game, gameContext(now));
    table.status = table.game.status;
  }
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.store = new GitHubState(ctx, env, 'online/lobby');
    this.tail = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => {
      this.state = await this.store.load() ?? { version: 1, users: [], tables: [] };
      if (this.state.version !== 1 || !Array.isArray(this.state.users) || !Array.isArray(this.state.tables)) {
        throw new Error('Unsupported online lobby snapshot');
      }
      // A fresh instance can lose every socket on redeploy, or keep all sockets across hibernation.
      let changed = false;
      const now = Date.now();
      for (const table of this.state.tables) for (const seat of table.seats) {
        if (seat.offlineSince == null && !this.online(seat.id)) {
          seat.offlineSince = now;
          changed = true;
        }
      }
      const unrecorded = this.state.tables.filter(t => t.status === 'ended' && !t.finishedAt);
      if (unrecorded.length) await this.saveTables(this.state.tables, unrecorded);
      else if (changed) await this.store.save(this.state);
      await this.schedule();
    });
  }

  // Crypto, GitHub and storage await points can otherwise interleave two derived snapshots.
  serial(fn) {
    const work = this.tail.then(fn);
    this.tail = work.catch(() => {});
    return work;
  }

  async schedule() {
    const flushAt = await this.store.getNextFlushAt();
    let deadline = flushAt ?? Infinity;
    for (const table of this.state.tables) deadline = Math.min(deadline, nextTableDeadline(table));
    for (const pending of this.state.archives || []) deadline = Math.min(deadline, pending.next);
    const armed = await this.ctx.storage.getAlarm();
    if (deadline === Infinity) {
      if (armed != null) await this.ctx.storage.deleteAlarm();
    } else if (armed !== deadline) {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, deadline));
    }
  }

  async commit(state) {
    await this.store.save(state);
    this.state = state;
    await this.schedule();
  }

  online(uid, except = null) {
    return this.ctx.getWebSockets(uid).some(ws => ws !== except && ws.readyState === 1);
  }

  tableOf(uid) {
    return this.state.tables.find(t => t.seats.some(s => s.id === uid));
  }

  async commitTable(table) {
    const tables = this.state.tables.filter(t => t.id !== table.id);
    if (table.seats.length) {
      const oldIndex = this.state.tables.findIndex(t => t.id === table.id);
      tables.splice(oldIndex < 0 ? tables.length : oldIndex, 0, table);
    }
    await this.saveTables(tables, [table]);
  }

  async saveTables(tables, changed) {
    let { users, archives = [] } = this.state;
    for (const table of changed) {
      if (table.status !== 'ended' || table.finishedAt) continue;
      table.matchId ??= crypto.randomUUID();
      table.finishedAt = Date.now();
      const record = { code: table.code, matchId: table.matchId, finishedAt: table.finishedAt, game: table.game };
      archives = [...archives, { record, next: Date.now(), failures: 0 }];
      const lastResult = {
        matchId: table.matchId, name: table.name, finishedAt: table.finishedAt,
        winner: table.game.winner, endReason: table.game.endReason, ranking: table.game.ranking,
      };
      users = users.map(u => table.game.players.some(p => p.id === u.id) ? { ...u, lastResult } : u);
    }
    await this.commit({ ...this.state, tables, users, archives });
  }

  async handoffArchive(now) {
    const pending = this.state.archives?.find(item => item.next <= now);
    if (!pending) return;
    let archives;
    try {
      await deliverArchive(this.env, 'online', pending.record);
      archives = this.state.archives.filter(item => item !== pending);
    } catch {
      const failures = pending.failures + 1;
      const retry = { ...pending, failures, next: Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(6, failures - 1)) };
      archives = this.state.archives.map(item => item === pending ? retry : item);
    }
    await this.commit({ ...this.state, archives });
  }

  broadcastLobby() {
    const message = { t: 'lobby', tables: lobbyView(this.state.tables) };
    for (const ws of this.ctx.getWebSockets()) send(ws, message);
  }

  broadcastTable(table) {
    if (!table.seats.length) return;
    const seats = table.seats.map(({ id, name, ready }) => ({ id, name, ready, online: this.online(id) }));
    const msg = { t: 'table', table: { ...table, seats, game: table.game ? publicView(table.game) : null } };
    for (const seat of seats) for (const socket of this.ctx.getWebSockets(seat.id)) send(socket, msg);
  }

  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/ws') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: '需要 WebSocket' }, 426);
        const token = url.searchParams.get('token') || '';
        const tokenHash = /^[a-f0-9]{48}$/.test(token) ? await digest(token) : null;
        return await this.serial(() => this.connect(tokenHash));
      }
      if (!['/api/register', '/api/login'].includes(url.pathname)) return json({ error: '找不到此接口' }, 404);
      if (req.method !== 'POST') return json({ error: '需要 POST' }, 405);
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      if (!await this.consumeAuthBudget(ip)) {
        await req.body?.cancel();
        return json({ error: '尝试次数过多，稍后再试' }, 429);
      }
      const input = await credentials(req);
      return await this.serial(() => this.auth(input, url.pathname === '/api/register'));
    } catch (e) {
      if (e instanceof RuleError) return json({ error: e.message }, 400);
      console.error('Account lobby request failed', e.name);
      return json({ error: '大厅暂时无法保存，请稍后重试' }, 503);
    }
  }

  async consumeAuthBudget(ip) {
    const client = await digest(ip);
    const bucket = Math.floor(Date.now() / 600_000);
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS auth_budget (client TEXT PRIMARY KEY, bucket INTEGER NOT NULL, attempts INTEGER NOT NULL)');
    sql.exec('DELETE FROM auth_budget WHERE bucket < ?', bucket);
    const [{ attempts }] = sql.exec(
      'INSERT INTO auth_budget VALUES (?, ?, 1) ON CONFLICT(client) DO UPDATE SET attempts=attempts+1 RETURNING attempts', client, bucket
    ).toArray();
    return attempts <= 40;
  }

  async auth({ name, password }, register) {
    let user = this.state.users.find(u => u.name === name);
    if (register) {
      if (user) reject('这个昵称已经有人用了');
      const salt = hex(randomBytes(16));
      user = { id: crypto.randomUUID(), name, salt, passwordHash: await hashPassword(password, salt), tokens: [] };
    } else {
      const suppliedHash = await hashPassword(password, user?.salt || '00000000000000000000000000000000');
      if (!user || !matchesHash(suppliedHash, user.passwordHash)) return json({ error: '昵称或密码不对' }, 401);
    }
    const token = hex(randomBytes(24));
    const tokenHash = await digest(token);
    user = { ...user, tokens: [tokenHash, ...user.tokens].slice(0, SESSION_LIMIT) };
    const users = this.state.users.filter(u => u.id !== user.id);
    users.push(user);
    await this.commit({ ...this.state, users });
    for (const ws of this.ctx.getWebSockets(user.id)) {
      if (!user.tokens.includes(ws.deserializeAttachment()?.tokenHash)) {
        send(ws, { t: 'auth', ok: false });
        ws.close(1008, 'Session expired');
      }
    }
    return json({ token, user: publicUser(user) });
  }

  async connect(tokenHash) {
    const user = tokenHash && this.state.users.find(u => u.tokens.includes(tokenHash));
    const [client, ws] = Object.values(new WebSocketPair());
    if (!user) {
      this.ctx.acceptWebSocket(ws);
      send(ws, { t: 'auth', ok: false });
      ws.close(1008, 'Authentication required');
    } else {
      this.ctx.acceptWebSocket(ws, [user.id]);
      ws.serializeAttachment({ uid: user.id, tokenHash });
      const existing = this.tableOf(user.id);
      const table = existing && structuredClone(existing);
      const seat = table?.seats.find(s => s.id === user.id);
      if (seat?.offlineSince != null) {
        seat.offlineSince = null;
        await this.commitTable(table);
      }
      send(ws, { t: 'auth', ok: true, user: publicUser(user), lastResult: user.lastResult || null });
      send(ws, { t: 'lobby', tables: lobbyView(this.state.tables) });
      if (table) this.broadcastTable(table);
      else send(ws, { t: 'table', table: null });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, raw) {
    return this.serial(async () => {
      const attachment = socket.deserializeAttachment();
      const user = attachment && this.state.users.find(u => u.id === attachment.uid && u.tokens.includes(attachment.tokenHash));
      if (!user) return socket.close(1008, 'Authentication required');
      if (typeof raw !== 'string' || raw.length > 4096) return socket.close(1009, 'Invalid message');
      try {
        const message = JSON.parse(raw);
        if (!message || typeof message.t !== 'string') reject('消息格式不正确');
        const previous = this.tableOf(user.id);
        let table;
        switch (message.t) {
          case 'create': {
            if (previous) reject('你已经在一张桌子上了');
            table = createTable(this.state.tables, user, message);
            break;
          }
          case 'join': {
            const code = String(message.code || '').trim().toUpperCase();
            const target = message.tableId ? this.state.tables.find(t => t.id === message.tableId) : this.state.tables.find(t => t.code === code);
            if (!target) reject(code ? '邀请码不对' : '桌子不存在了');
            if (previous?.id === target.id) return this.broadcastTable(target);
            if (previous) reject('你已经在一张桌子上了，先离开');
            if (target.status !== 'waiting') reject('这桌已经开局了');
            if (target.seats.length >= target.max) reject('这桌满了');
            if (target.locked && code !== target.code) reject('这桌上锁了，需要邀请码');
            table = structuredClone(target);
            table.seats.push({ ...publicUser(user), ready: false, offlineSince: null });
            break;
          }
          default:
            if (!previous) reject('你不在桌子上');
            table = structuredClone(previous);
            tableAction(table, user, message);
        }
        await this.commitTable(table);
        if (message.t === 'leave') {
          for (const ws of this.ctx.getWebSockets(user.id)) send(ws, { t: 'table', table: null });
        }
        this.broadcastTable(table);
        if (message.t !== 'act' || table.status !== previous?.status) this.broadcastLobby();
      } catch (e) {
        if (!(e instanceof SyntaxError || e instanceof RuleError)) console.error('Account lobby action failed', e.name);
        send(socket, { t: 'error', msg: e instanceof RuleError ? e.message : e instanceof SyntaxError ? '消息格式不正确' : '操作失败，请重试' });
      }
    });
  }

  webSocketClose(ws, code) {
    return this.serial(async () => {
      const uid = ws.deserializeAttachment()?.uid;
      if (ws.readyState !== 3) ws.close(code === 1000 ? 1000 : 1001, 'Disconnected');
      if (!uid || this.online(uid, ws)) return;
      const previous = this.tableOf(uid);
      if (!previous) return;
      const table = structuredClone(previous);
      table.seats.find(s => s.id === uid).offlineSince ??= Date.now();
      await this.commitTable(table);
      this.broadcastTable(table);
    });
  }

  webSocketError(ws) {
    return this.webSocketClose(ws, 1001);
  }

  alarm() {
    return this.serial(async () => {
      const now = Date.now();
      const changed = new Map();
      for (const existing of this.state.tables) {
        if (now < nextTableDeadline(existing)) continue;
        const table = structuredClone(existing);
        advanceTable(table, now);
        changed.set(table.id, table);
      }
      if (changed.size) {
        const tables = this.state.tables.map(t => changed.get(t.id) || t).filter(t => t.seats.length);
        await this.saveTables(tables, changed.values());
        for (const table of changed.values()) this.broadcastTable(table);
        this.broadcastLobby();
      }
      try {
        await this.handoffArchive(now);
        if ((await this.store.getNextFlushAt() ?? Infinity) <= now) await this.store.flush();
      } finally {
        await this.schedule();
      }
    });
  }
}
