// One Durable Object owns one invite code. The rule engine is identical to local play.
import { act, autoAct, createGame, current, finishNow, legalActions, publicView, RuleError } from '../shared/engine.js';
import { CHARS, SQUARES, TURN_SECONDS } from '../shared/board.js';
import { GitHubState } from './storage.js';
import { deliverArchive } from './matches.js';
export { MatchArchive } from './matches.js';

const TURN_MS = TURN_SECONDS * 1000;
const OFFLINE_MS = 3000;
const SEAT_GRACE = 60_000;
const CLAIM_TTL = 10 * 60_000;
const MAX_SEATS = 6;
const SHOW_MS = 15_000;
const CONFIRM_MS = 20_000;
const AUTOEND_MS = 3000;
const roomCode = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const clock = () => ({ now: Date.now(), rng: Math.random });
const secret = () => crypto.randomUUID().replaceAll('-', '');
const rule = (message) => {
  throw new RuleError(message);
};

async function hash(token) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function newSeat(token, now) {
  return {
    id: 'p' + secret().slice(0, 12),
    tokenHash: await hash(token),
    name: '',
    avatar: null,
    edited: false,
    ready: false,
    offlineSince: now,
    claim: null,
  };
}

function promptFor(game, e, eventIndex) {
  let title,
    button,
    lines,
    tone = 'pay',
    amount = e.amount || 0;
  if (e.k === 'charge' && e.kind !== 'mortgaged') {
    title = e.kind === 'jailfine' ? '出狱罚金' : SQUARES[e.square].name;
    button = { tax: '交税', jailfine: '交罚金', rent: '付过路费' }[e.kind];
    lines = [e.to ? '收款人：' + game.players.find((p) => p.id === e.to).name : '收款人：银行'];
    button += ' $' + amount;
  } else if (e.k === 'card') {
    title = e.deck === 'chance' ? '机会卡' : '命运卡';
    button = '知道了';
    tone = e.mood;
    lines = [e.text];
  } else if (e.k === 'jail' && e.reason !== 'card') {
    title = '进监狱';
    button = '进入监狱';
    tone = 'bad';
    lines = [e.reason === 'doubles' ? '连续三次双数，直接入狱。' : '停在入狱格，直接入狱。'];
  } else if (e.k === 'bankruptcy') {
    title = '破产清算';
    button = '确认清算';
    tone = 'bad';
    amount = e.cash;
    lines = [
      '欠款 $' + e.owed,
      e.props.length + ' 处地产移交给' + (e.to ? game.players.find((p) => p.id === e.to).name : '银行'),
    ];
  } else return null;
  return { id: game.seq + '.' + eventIndex, seq: game.seq, eventIndex, pid: e.pid, title, button, amount, tone, lines };
}

function planAutoEnd(r, now) {
  r.autoEnd = null;
  if (r.status !== 'playing' || r.game.phase !== 'manage') return;
  const p = current(r.game);
  if (r.hold === p.id || r.game.offer?.from === p.id) return;
  if (legalActions(r.game, p.id).some((a) => a.type === 'build' && a.square === r.game.stop?.square)) return;
  r.autoEnd = { pid: p.id, at: now + AUTOEND_MS };
}

function released(r, now) {
  r.playback = null;
  if (r.status === 'playing') r.game.deadline = now + TURN_MS;
  planAutoEnd(r, now);
}

function advancePrompt(r, now, online) {
  const play = r.playback;
  while (play.prompts.length && !online.has(play.prompts[0].pid)) play.prompts.shift();
  play.promptUntil = play.prompts.length ? now + CONFIRM_MS : null;
  play.showUntil = now + SHOW_MS;
  if (!play.prompts.length && (play.played || !online.has(play.pid))) released(r, now);
}

function beginPlayback(r, actor, now, online) {
  r.status = r.game.status;
  r.autoEnd = null;
  if (r.status === 'ended') {
    r.matchId ??= crypto.randomUUID();
    const record = { code: r.code, matchId: r.matchId, finishedAt: now, game: r.game };
    (r.archiveQueue ??= []).push(record);
    r.archiveAt ??= now;
    r.lastCompleted = { matchId: r.matchId, finishedAt: now, winner: r.game.winner, ranking: r.game.ranking };
  }
  if (r.game.events.some((e) => e.k === 'turn')) r.hold = null;
  const prompts = r.game.events.map((e, index) => promptFor(r.game, e, index)).filter(Boolean);
  // When the actor is offline, another connected browser still presents the move.
  const pid = online.has(actor) ? actor : r.seats.find((s) => online.has(s.id))?.id;
  r.playback = { pid, played: false, seq: r.game.seq, prompts };
  advancePrompt(r, now, online);
}

function shiftClocks(r, ms) {
  if (r.game?.endsAt) r.game.endsAt += ms;
  if (r.game) r.game.deadline += ms;
  if (r.autoEnd) r.autoEnd.at += ms;
  if (r.playback) {
    r.playback.showUntil += ms;
    if (r.playback.promptUntil) r.playback.promptUntil += ms;
  }
}

export class GuestRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }

  // GitHub restore/flush can yield outside the DO input gate. Keep commands and alarm
  // transitions in arrival order, including overlapping purchases from different sockets.
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  async load(code) {
    if (!this.store) {
      code ||= await this.ctx.storage.get('roomCode');
      if (!code) return;
      this.store = new GitHubState(this.ctx, this.env, 'rooms/' + code);
      this.code = code;
    }
    if (this.room === undefined) {
      this.room = await this.store.load();
      if (this.room) {
        // Reconcile after an eviction or restore in a fresh namespace with no live sockets.
        const online = this.online();
        const r = structuredClone(this.room);
        const now = Date.now();
        for (const seat of r.seats) {
          if (!online.has(seat.id)) seat.offlineSince ??= now;
          else seat.offlineSince = null;
        }
        if (!online.size && r.status === 'playing') r.emptySince ??= r.updatedAt || now;
        if (JSON.stringify(r) !== JSON.stringify(this.room)) await this.save(r);
        else await this.schedule();
      }
    }
  }

  sockets(exclude) {
    return this.ctx.getWebSockets('seat').filter((ws) => ws !== exclude && ws.readyState === 1);
  }
  online(exclude) {
    return new Set(
      this.sockets(exclude)
        .map((ws) => ws.deserializeAttachment()?.pid)
        .filter(Boolean)
    );
  }

  view(r, now, online) {
    const paused = r.pausedAt;
    return {
      code: r.code,
      status: r.status,
      min: 2,
      max: MAX_SEATS,
      hostId: r.hostId,
      joinUrl: r.origin + '/p/' + r.code,
      seats: r.seats.map((s) => ({
        id: s.id,
        name: s.name,
        avatar: s.avatar,
        ready: s.ready,
        online: online.has(s.id),
      })),
      game: r.game && publicView(r.game),
      showing: !!r.playback,
      presenterId: r.playback?.pid || null,
      waitingFor: r.playback?.prompts[0] || null,
      paused,
      autoEnd: !paused && r.autoEnd ? { pid: r.autoEnd.pid, left: Math.max(0, r.autoEnd.at - now) } : null,
    };
  }

  broadcast(extra = {}) {
    const view = this.view(this.room, Date.now(), this.online());
    for (const ws of this.sockets()) {
      try {
        ws.send(JSON.stringify({ t: 'room', room: view, me: ws.deserializeAttachment().pid, ...extra }));
      } catch {
        /* The close event updates presence. */
      }
    }
  }

  async save(r) {
    r.updatedAt = Date.now();
    await this.store.save(r);
    this.room = r;
    await this.schedule();
  }

  deadlines(r, online) {
    if (!r || !online.size) return [];
    const list = r.seats
      .filter((s) => s.offlineSince && (r.status === 'waiting' || s.id === r.hostId))
      .map((s) => s.offlineSince + SEAT_GRACE);
    if (r.pausedAt || r.emptySince) return list;
    if (r.playback) {
      list.push(r.playback.promptUntil ?? r.playback.showUntil);
    } else if (r.status === 'playing') {
      if (r.autoEnd) list.push(r.autoEnd.at);
      const pid = current(r.game).id;
      list.push(r.game.deadline - (online.has(pid) ? 0 : TURN_MS - OFFLINE_MS));
    }
    return list;
  }

  async schedule() {
    const due = this.deadlines(this.room, this.online());
    if (this.room?.archiveAt != null) due.push(this.room.archiveAt);
    const git = await this.store.getNextFlushAt();
    if (git != null) due.push(git);
    const next = due.length ? Math.max(Date.now() + 1, Math.min(...due)) : null;
    const old = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (old !== null) await this.ctx.storage.deleteAlarm();
    } else if (old !== next) await this.ctx.storage.setAlarm(next);
  }

  fetch(req) {
    return this.serial(async () => {
      const url = new URL(req.url);
      const code = req.headers.get('x-room-code') || url.searchParams.get('room');
      if (!roomCode.test(code || '')) return Response.json({ error: '无效房间码' }, { status: 400 });
      await this.load(code);
      if (this.code !== code) return new Response('Room mismatch', { status: 400 });
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        if (this.room) return Response.json({ error: '房间码已存在' }, { status: 409 });
        const token = secret(),
          seat = await newSeat(token, Date.now());
        await this.ctx.storage.put('roomCode', code);
        await this.save({
          code,
          origin: url.origin,
          seats: [seat],
          hostId: seat.id,
          status: 'waiting',
          game: null,
          playback: null,
          autoEnd: null,
          hold: null,
          pausedAt: null,
          emptySince: null,
        });
        return Response.json({ code, token, me: seat.id }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname !== '/ws' || req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
        return new Response('Not found', { status: 404 });
      const [client, ws] = Object.values(new WebSocketPair());
      const denied = (reason, msg) => {
        this.ctx.acceptWebSocket(ws, ['denied']);
        ws.send(JSON.stringify({ t: 'denied', reason, msg }));
        ws.close(1008, reason);
        return new Response(null, { status: 101, webSocket: client });
      };
      if (!this.room) return denied('gone', '房间不存在，请检查房间码');
      // A GitHub-only restore must also restore the local routing key for alarms.
      if ((await this.ctx.storage.get('roomCode')) !== code) await this.ctx.storage.put('roomCode', code);
      const r = structuredClone(this.room);
      const online = this.online(),
        now = Date.now();
      let token = url.searchParams.get('token') || '';
      let seat;
      const claim = url.searchParams.get('claim');
      if (claim) {
        const claimHash = await hash(claim);
        seat = r.seats.find((s) => s.claim?.hash === claimHash && s.claim.until > now && !online.has(s.id));
        if (!seat) return denied('claim', '恢复链接已失效，请向房主索取新链接');
        token = secret();
        seat.tokenHash = await hash(token);
        seat.claim = null;
      } else if (token) {
        const tokenHash = await hash(token);
        seat = r.seats.find((s) => s.tokenHash === tokenHash);
        if (!seat) return denied('token', '座位已失效，请重新加入或使用房主的恢复链接');
      } else {
        if (r.status !== 'waiting') return denied('started', '已经开局了，等下一局吧');
        // A full lobby can be completely asleep with no alarm. Reclaim expired
        // seats on this join so the next friend can enter an abandoned lobby.
        r.seats = r.seats.filter((s) => online.has(s.id) || !s.offlineSince || now - s.offlineSince < SEAT_GRACE);
        if (r.seats.length >= MAX_SEATS) return denied('full', '房间已满（最多 6 人）');
        token = secret();
        seat = await newSeat(token, now);
        r.seats.push(seat);
        if (!r.seats.some((s) => s.id === r.hostId)) r.hostId = r.seats.find((s) => online.has(s.id))?.id || seat.id;
      }
      if (r.emptySince) {
        if (!r.pausedAt) shiftClocks(r, now - r.emptySince);
        r.emptySince = null;
      }
      seat.offlineSince = null;
      seat.claim = null;
      this.ctx.acceptWebSocket(ws, ['seat']);
      ws.serializeAttachment({ pid: seat.id });
      await this.save(r);
      ws.send(JSON.stringify({ t: 'token', token }));
      this.broadcast();
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  webSocketMessage(ws, raw) {
    return this.serial(async () => {
      try {
        if (typeof raw !== 'string' || raw.length > 8192) rule('消息格式错误');
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          rule('消息格式错误');
        }
        if (!m || typeof m !== 'object' || Array.isArray(m)) rule('消息格式错误');
        await this.load();
        const r = structuredClone(this.room),
          pid = ws.deserializeAttachment()?.pid;
        const seat = r?.seats.find((s) => s.id === pid);
        if (!seat) rule('你的座位已失效');
        const { now } = clock(),
          online = this.online();
        if (['start', 'pause', 'resume', 'finish', 'again', 'claimLink'].includes(m.t) && r.hostId !== pid)
          rule('只有房主可以操作');
        if (['pick', 'name', 'ready', 'start'].includes(m.t) && r.status !== 'waiting') rule('已经开局了');
        let extra = {},
          reply;
        switch (m.t) {
          case 'pick': {
            const char = CHARS.find((c) => c.code === m.code);
            if (!char) rule('没有这个角色');
            if (r.seats.some((s) => s !== seat && s.avatar === m.code)) rule('这个角色已经有人选了');
            seat.avatar = m.code;
            if (!seat.edited) seat.name = char.name;
            break;
          }
          case 'name': {
            const name = [...String(m.v || '').trim()].slice(0, 6).join('');
            seat.name = name || CHARS.find((c) => c.code === seat.avatar)?.name || '';
            seat.edited = !!name;
            break;
          }
          case 'ready':
            if (m.v && !seat.avatar) rule('先选一个角色');
            seat.ready = !!m.v;
            break;
          case 'start':
            if (r.seats.length < 2) rule('至少要 2 个人');
            if (r.seats.some((s) => !s.ready)) rule('还有人没选好角色');
            r.matchId = crypto.randomUUID();
            r.game = createGame(r.seats, { durationMin: 60 }, clock());
            beginPlayback(r, current(r.game).id, now, online);
            extra = { started: true };
            break;
          case 'act': {
            if (r.status !== 'playing') rule('对局没在进行');
            if (r.pausedAt) rule('暂停中');
            if (r.playback) rule('请等本次动画和确认完成');
            if (m.seq != null && m.seq !== r.game.seq) rule('局面已更新');
            if (m.action?.type === 'buy' && m.action.build != null && !Number.isInteger(m.action.build))
              rule('建房数须为整数');
            act(r.game, pid, m.action || {}, clock());
            beginPlayback(r, pid, now, online);
            extra = { events: true };
            break;
          }
          case 'hold':
            if (r.status !== 'playing' || current(r.game).id !== pid) return;
            r.hold = pid;
            r.autoEnd = null;
            break;
          case 'played': {
            const p = r.playback;
            if (!p || r.pausedAt || p.seq !== m.seq || p.pid !== pid || p.played) return;
            p.played = true;
            if (!p.prompts.length) released(r, now);
            break;
          }
          case 'ack': {
            const p = r.playback,
              prompt = p?.prompts[0];
            if (!prompt || r.pausedAt || prompt.pid !== pid || prompt.seq !== m.seq || prompt.id !== m.id) return;
            p.prompts.shift();
            advancePrompt(r, now, online);
            break;
          }
          case 'pause':
            if (r.status !== 'playing' || r.pausedAt) return;
            r.pausedAt = now;
            break;
          case 'resume':
            if (!r.pausedAt) return;
            shiftClocks(r, now - r.pausedAt);
            r.pausedAt = null;
            break;
          case 'finish':
            if (r.status !== 'playing') rule('对局没在进行');
            r.pausedAt = null;
            finishNow(r.game, clock());
            beginPlayback(r, pid, now, online);
            extra = { events: true };
            break;
          case 'again':
            if (r.status !== 'ended') rule('对局还没结束');
            Object.assign(r, {
              status: 'waiting',
              game: null,
              playback: null,
              hold: null,
              autoEnd: null,
              pausedAt: null,
            });
            for (const s of r.seats) s.ready = false;
            break;
          case 'claimLink': {
            const lost = r.seats.find((s) => s.id === m.pid);
            if (!lost || online.has(lost.id)) rule('只能恢复离线座位');
            const key = secret();
            lost.claim = { hash: await hash(key), until: now + CLAIM_TTL };
            reply = { t: 'claimLink', pid: lost.id, url: r.origin + '/p/' + r.code + '?claim=' + key };
            break;
          }
          default:
            rule('未知操作');
        }
        await this.save(r);
        if (reply) ws.send(JSON.stringify(reply));
        this.broadcast(extra);
      } catch (e) {
        if (!(e instanceof RuleError)) console.error('room message:', e.message);
        ws.send(JSON.stringify({ t: 'error', msg: e instanceof RuleError ? e.message : '未能保存操作，请重试' }));
      }
    });
  }

  webSocketClose(ws, code, reason) {
    return this.serial(async () => {
      const pid = ws.deserializeAttachment()?.pid;
      try {
        ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
      } catch {}
      if (!pid) return;
      await this.load();
      const online = this.online(ws),
        now = Date.now();
      if (online.has(pid) || !this.room) return;
      const r = structuredClone(this.room),
        seat = r.seats.find((s) => s.id === pid);
      if (!seat) return;
      seat.offlineSince = now;
      if (!online.size && r.status === 'playing') r.emptySince ??= now;
      if (r.playback) {
        if (r.playback.pid === pid) r.playback.played = true;
        if (r.playback.prompts[0]?.pid === pid || (r.playback.played && !r.playback.prompts.length))
          advancePrompt(r, now, online);
      }
      await this.save(r);
      this.broadcast();
    });
  }

  webSocketError(ws) {
    return this.webSocketClose(ws, 1011, '连接中断');
  }

  alarm() {
    return this.serial(async () => {
      await this.load();
      if (!this.store) return;
      const r = this.room && structuredClone(this.room),
        now = Date.now(),
        online = this.online();
      let changed = false,
        events = false;
      if (r && online.size) {
        // If everyone left, retain the snapshot for a later reunion. With active
        // players, vacant pre-game seats and the host can be replaced after a minute.
        const host = r.seats.find((s) => s.id === r.hostId);
        if (host?.offlineSince && now - host.offlineSince >= SEAT_GRACE) {
          r.hostId = r.seats.find((s) => online.has(s.id)).id;
          changed = true;
        }
        if (r.status === 'waiting') {
          const seats = r.seats.filter((s) => !s.offlineSince || now - s.offlineSince < SEAT_GRACE);
          if (seats.length !== r.seats.length) {
            r.seats = seats;
            changed = true;
          }
        }
        if (!r.pausedAt && !r.emptySince) {
          if (r.playback) {
            const p = r.playback;
            if (p.prompts.length && now >= p.promptUntil) {
              p.prompts.shift();
              advancePrompt(r, now, online);
              changed = true;
            } else if (!p.prompts.length && now >= p.showUntil) {
              released(r, now);
              changed = true;
            }
          } else if (r.status === 'playing') {
            const pid = current(r.game).id;
            const deadline = r.game.deadline - (online.has(pid) ? 0 : TURN_MS - OFFLINE_MS);
            if (r.autoEnd?.at <= now) {
              act(r.game, pid, { type: 'end' }, clock());
              beginPlayback(r, pid, now, online);
              changed = events = true;
            } else if (deadline <= now) {
              autoAct(r.game, clock());
              beginPlayback(r, pid, now, online);
              changed = events = true;
            }
          }
        }
      }
      if (changed) {
        await this.save(r);
        this.broadcast(events ? { events: true } : {});
      }
      if (r?.archiveAt != null && r.archiveAt <= now) {
        try {
          await deliverArchive(this.env, r.code, r.archiveQueue[0]);
          r.archiveQueue.shift();
          r.archiveAt = r.archiveQueue.length ? Date.now() : null;
        } catch (e) {
          console.error('Completed game handoff deferred', r.code, e.message);
          r.archiveAt = Date.now() + 15_000;
        }
        await this.save(r);
      }
      const due = await this.store.getNextFlushAt();
      try {
        if (due != null && due <= Date.now()) await this.store.flush();
      } finally {
        await this.schedule();
      }
    });
  }
}
