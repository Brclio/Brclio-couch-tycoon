// 聚会模式：大屏开房间，手机扫码进来当手柄。房间存在内存里，不用登录。
// 连接：/ws?party=screen&room=&key=（大屏）· /ws?party=phone&room=&token=（手机）
import os from 'node:os';
import crypto from 'node:crypto';
import { createGame, publicView, act, autoAct, current, finishNow, legalActions, RuleError } from './shared/engine.js';
import { CHARS, TURN_SECONDS } from './shared/board.js';

const MIN_SEATS = 2, MAX_SEATS = 6;
const DURATION_MIN = 60;
const WAITING_GRACE = 60_000;       // 开局前掉线 1 分钟让出座位
const ROOM_IDLE = 30 * 60_000;      // 大屏和手机都不在 30 分钟，房间解散
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OFFLINE_TURN = 3_000;         // 掉线玩家轮到时 3 秒后自动操作
// 下面几个可用环境变量调（测试用）
const CONFIRM_MS = Number(process.env.PARTY_CONFIRM_MS || 20_000);  // 手机多久不确认，大屏自动继续
const SHOW_MS = Number(process.env.PARTY_SHOW_MS || 15_000);        // 大屏多久没动静，就不再等它演完
const AUTOEND_MS = Number(process.env.PARTY_AUTOEND_MS || 3_000);   // 没事可做时，多久替他结束回合
const DICE = String(process.env.PARTY_DICE || '').split(',').map(Number).filter(n => n >= 1 && n <= 6);  // 指定点数，默认关

const rooms = new Map();   // 房间码 -> room
const conns = new Map();   // ws -> { room, seat }（seat 为 null 是大屏）
let port = 0;

// 测试时按 PARTY_DICE 依次出点数，用完了回到随机
const rng = () => DICE.length ? (DICE.shift() - 0.5) / 6 : Math.random();
const ctx = () => ({ now: Date.now(), rng });
const token = () => crypto.randomBytes(16).toString('hex');
const charName = (code) => CHARS.find(c => c.code === code)?.name || '';

// 手机要打开的地址：电脑的局域网 IPv4，192.168 优先，其次 10.、172.16–31
export function lanIp() {
  if (process.env.PARTY_HOST) return process.env.PARTY_HOST;
  const rank = (a) => a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 9;
  const all = Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal && rank(a.address) < 9)
    .map(a => a.address)
    .sort((a, b) => rank(a) - rank(b));
  return all[0] || 'localhost';
}

export const joinBase = () => `http://${lanIp()}:${port}`;

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function online(room, seat) {
  for (const c of conns.values()) if (c.room === room && c.seat === seat) return true;
  return false;
}

function roomView(r) {
  return {
    code: r.code, status: r.status, min: MIN_SEATS, max: MAX_SEATS,
    joinUrl: `${joinBase()}/p/${r.code}`,
    seats: r.seats.map(s => ({ id: s.id, name: s.name, avatar: s.avatar, ready: s.ready, online: online(r, s) })),
    game: r.game ? publicView(r.game) : null,
    showing: !!r.showing,                       // 大屏还在演上一个动作，手机先别动
    waitingFor: r.waiting ? { ...r.waiting, timer: undefined } : null,  // 等谁在手机上确认
    paused: r.paused?.at || null,               // 暂停的时刻，大屏用它停住时钟
    // { pid, left }：再过 left 毫秒替 pid 结束回合（发剩余时间，手机和电脑的钟可能对不上）
    autoEnd: r.autoEnd && !r.paused ? { pid: r.autoEnd.pid, left: Math.max(0, r.autoEnd.at - Date.now()) } : null,
  };
}

function broadcast(r, extra = {}) {
  const room = roomView(r);
  for (const [ws, c] of conns) {
    if (c.room !== r) continue;
    ws.send(JSON.stringify({ t: 'room', room, me: c.seat?.id ?? null, ...extra }));
  }
}

const reply = (ws, msg) => ws.send(JSON.stringify(msg));

export function connect(ws, q) {
  const role = q.get('party');
  const code = String(q.get('room') || '').toUpperCase();
  let r = rooms.get(code);

  if (role === 'screen') {
    // 大屏刷新：带着房间码和钥匙回到原房间；否则开新房间
    // 服务器重启过（房间没了）：大屏带来的房间码没人用，就照原码重开，墙上的二维码还能扫
    const reopen = !r && /^[A-Z2-9]{4}$/.test(code) && /^[0-9a-f]{32}$/.test(q.get('key') || '');
    if (!r || r.key !== q.get('key')) {
      r = { code: reopen ? code : newCode(), key: reopen ? q.get('key') : token(), status: 'waiting', seats: [], game: null, idleSince: null, showing: null, waiting: null, paused: null };
      rooms.set(r.code, r);
    }
    conns.set(ws, { room: r, seat: null });
    reply(ws, { t: 'screen', code: r.code, key: r.key });
  } else {
    if (!r) { reply(ws, { t: 'denied', reason: 'gone', msg: '房间不存在了，请重新扫大屏上的二维码' }); return ws.close(); }
    let seat = r.seats.find(s => s.token === q.get('token'));
    // 手机换了浏览器或清了缓存，没有原来的 token：可以认领一个掉线的座位
    if (!seat && q.get('claim')) seat = r.seats.find(s => s.id === q.get('claim') && !online(r, s));
    if (!seat) {
      const free = r.seats.filter(s => !online(r, s)).map(s => ({ id: s.id, name: s.name, avatar: s.avatar }));
      if (r.status !== 'waiting') { reply(ws, { t: 'denied', reason: 'started', msg: '已经开局了，等下一局吧', free }); return ws.close(); }
      if (r.seats.length >= MAX_SEATS) { reply(ws, { t: 'denied', reason: 'full', msg: `房间已满（最多 ${MAX_SEATS} 人）`, free }); return ws.close(); }
      seat = { id: `p${crypto.randomBytes(4).toString('hex')}`, token: token(), name: '', avatar: null, edited: false, ready: false, offlineSince: null };
      r.seats.push(seat);
    }
    seat.offlineSince = null;
    conns.set(ws, { room: r, seat });
    reply(ws, { t: 'token', token: seat.token });
  }
  r.idleSince = null;
  broadcast(r);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const c = conns.get(ws);
    if (!c) return;
    try {
      if (!c.seat && c.room.showing) c.room.showing.at = Date.now();   // 大屏有动静，说明还在演
      const h = (c.seat ? phoneHandlers : screenHandlers)[m.t];
      if (!h) return;
      const extra = h(c.room, c.seat, m);
      if (extra !== false) broadcast(c.room, extra || {});
    } catch (e) {
      if (!(e instanceof RuleError)) console.error(e);
      reply(ws, { t: 'error', msg: e instanceof RuleError ? e.message : '服务器出错了' });
    }
  });

  ws.on('close', () => {
    const c = conns.get(ws);
    conns.delete(ws);
    if (!c) return;
    if (c.seat && !online(c.room, c.seat)) {
      c.seat.offlineSince = Date.now();
      if (c.room.waiting?.pid === c.seat.id) ackWait(c.room);   // 等的人掉线了，大屏别干等
    }
    broadcast(c.room);
  });
}

const waiting = (r) => { if (r.status !== 'waiting') throw new RuleError('已经开局了'); };
const screensOf = (r) => [...conns].filter(([, c]) => c.room === r && !c.seat).map(([ws]) => ws);

// 引擎动了一步：等大屏演完（有大屏的话），演完前不收下一个操作
function stepped(r) {
  if (r.game.status === 'ended') r.status = 'ended';
  r.showing = screensOf(r).length ? { seq: r.game.seq, at: Date.now() } : null;
  if (!r.showing) planAutoEnd(r);
  return { events: true };
}

// 大屏演完，或者等不到了：放行，回合计时从现在开始
function released(r) {
  r.showing = null;
  clearWait(r);
  if (r.game?.status === 'playing') r.game.deadline = Date.now() + TURN_SECONDS * 1000;
  planAutoEnd(r);
}

// 回合只剩「结束」（和随时能办的贷款、卖房）时，倒数几秒替他结束。
// 还能在停留的国家上盖房、自己挂着地在卖、本人点了「等一下」，就等他自己点
function planAutoEnd(r) {
  r.autoEnd = null;
  const g = r.game;
  if (g?.status !== 'playing' || g.phase !== 'manage') return;
  const cur = current(g);
  if (r.hold && r.hold !== cur.id) r.hold = null;
  if (r.hold === cur.id || g.offer?.from === cur.id) return;
  if (legalActions(g, cur.id).some(a => a.type === 'build' && a.square === g.stop?.square)) return;
  r.autoEnd = { pid: cur.id, at: Date.now() + AUTOEND_MS };
}

function clearWait(r) {
  clearTimeout(r.waiting?.timer);
  r.waiting = null;
}

// 大屏弹框要等某人在手机上点确认；人不在或超时就替他点
function ackWait(r) {
  clearWait(r);
  for (const ws of screensOf(r)) reply(ws, { t: 'ack' });
}


const phoneHandlers = {
  pick(r, seat, m) {
    waiting(r);
    if (!CHARS.some(c => c.code === m.code)) throw new RuleError('没有这个角色');
    if (r.seats.some(s => s !== seat && s.avatar === m.code)) throw new RuleError('这个角色已经有人选了');
    seat.avatar = m.code;
    if (!seat.edited) seat.name = charName(m.code);
  },
  name(r, seat, m) {
    waiting(r);
    const v = [...String(m.v || '').trim()].slice(0, 6).join('');
    seat.edited = !!v;
    seat.name = v || charName(seat.avatar);
  },
  ready(r, seat, m) {
    waiting(r);
    if (m.v && !seat.avatar) throw new RuleError('先选一个角色');
    seat.ready = !!m.v;
  },
  act(r, seat, m) {
    if (r.status !== 'playing') throw new RuleError('对局没在进行');
    if (r.paused) throw new RuleError('暂停中');
    if (r.showing) throw new RuleError('等大屏演完');
    act(r.game, seat.id, m.action || {}, ctx());
    r.autoEnd = null;
    return stepped(r);
  },
  // 「等一下」：这一回合不自动结束
  hold(r, seat) {
    if (r.status !== 'playing' || current(r.game).id !== seat.id) return false;
    r.hold = seat.id;
    r.autoEnd = null;
  },
  ack(r, seat) {
    if (r.waiting?.pid !== seat.id) return false;
    ackWait(r);
  },
};

const screenHandlers = {
  start(r) {
    waiting(r);
    if (r.seats.length < MIN_SEATS) throw new RuleError(`至少要 ${MIN_SEATS} 个人`);
    if (r.seats.some(s => !s.ready)) throw new RuleError('还有人没选好角色');
    // 洗牌和排出手顺序用真随机，PARTY_DICE 只留给掷骰
    r.game = createGame(r.seats.map(s => ({ id: s.id, name: s.name, avatar: s.avatar })), { durationMin: DURATION_MIN }, { now: Date.now(), rng: Math.random });
    r.status = 'playing';
    r.paused = null;
    r.hold = null; r.autoEnd = null;
    r.showing = screensOf(r).length ? { seq: r.game.seq, at: Date.now() } : null;   // 倒计时和角色奖励演完再开始
    return { started: true };
  },
  // 大屏演完了 seq 这一步
  played(r, _, m) {
    if (!r.showing || m.seq !== r.showing.seq) return false;
    released(r);
  },
  // 大屏弹框等某人确认：{ pid, title, button, amount, tone, lines }
  wait(r, _, m) {
    clearWait(r);
    const pid = String(m.pid || '');
    const seat = r.seats.find(s => s.id === pid);
    if (!seat || !online(r, seat)) { ackWait(r); return false; }
    const clip = (v, n) => String(v ?? '').slice(0, n);
    r.waiting = {
      pid, title: clip(m.title, 40), button: clip(m.button, 24), tone: clip(m.tone, 10),
      amount: Number(m.amount) || 0, lines: (Array.isArray(m.lines) ? m.lines : []).slice(0, 3).map(l => clip(l, 120)),
      timer: setTimeout(() => { ackWait(r); broadcast(r); }, CONFIRM_MS),
    };
  },
  // 弹框被主持人跳过了
  unwait(r) {
    if (!r.waiting) return false;
    clearWait(r);
  },
  pause(r) {
    if (r.status !== 'playing' || r.paused) return false;
    r.paused = { at: Date.now() };
  },
  resume(r) {
    if (!r.paused) return false;
    const d = Date.now() - r.paused.at;
    if (r.game.endsAt) r.game.endsAt += d;
    r.game.deadline += d;
    if (r.autoEnd) r.autoEnd.at += d;
    r.paused = null;
  },
  finish(r) {
    if (r.status !== 'playing') throw new RuleError('对局没在进行');
    if (r.paused) screenHandlers.resume(r);
    clearWait(r);
    r.autoEnd = null;
    finishNow(r.game, ctx());
    return stepped(r);
  },
  again(r) {
    if (r.status !== 'ended') throw new RuleError('对局还没结束');
    r.status = 'waiting';
    r.game = null;
    r.showing = null;
    clearWait(r);
    r.seats.forEach(s => { s.ready = false; });
  },
};

// 开局前掉线太久让出座位；对局中超时自动操作；没人的房间过一阵解散
setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    if (r.status === 'playing' && !r.paused) {
      // 大屏不在了或者太久没动静，不再等它
      if (r.showing && (!screensOf(r).length || now - r.showing.at > SHOW_MS)) { released(r); broadcast(r); }
      if (!r.showing && r.autoEnd && now >= r.autoEnd.at) {
        const g = r.game, pid = r.autoEnd.pid;
        r.autoEnd = null;
        if (g.phase === 'manage' && current(g).id === pid) {
          try { act(g, current(g).id, { type: 'end' }, ctx()); broadcast(r, stepped(r)); } catch (e) { if (!(e instanceof RuleError)) console.error(e); }
        }
      }
      if (!r.showing) {
        const g = r.game, cur = current(g);
        const seat = r.seats.find(s => s.id === cur.id);
        const limit = seat && online(r, seat) ? g.deadline : Math.min(g.deadline, g.deadline - TURN_SECONDS * 1000 + OFFLINE_TURN);
        if (now >= limit) {
          autoAct(g, ctx());
          broadcast(r, stepped(r));
        }
      }
    }
    if (r.status === 'waiting') {
      const before = r.seats.length;
      r.seats = r.seats.filter(s => !s.offlineSince || now - s.offlineSince < WAITING_GRACE);
      if (r.seats.length !== before) broadcast(r);
    }
    const anyone = [...conns.values()].some(c => c.room === r);
    if (anyone) r.idleSince = null;
    else if (!r.idleSince) r.idleSince = now;
    else if (now - r.idleSince > ROOM_IDLE) rooms.delete(r.code);
  }
}, 250).unref();

export function setPort(p) { port = p; }
