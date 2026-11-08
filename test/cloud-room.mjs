// Run against a locally running Worker. Exercises the public invite/WS protocol.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { current, legalActions } from '../shared/engine.js';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
const address = new URL('/ws', base);
address.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
const clients = new Set();

function join(code, args = {}) {
  const url = new URL(address);
  url.search = new URLSearchParams({ party: 'phone', room: code, ...args });
  const ws = new WebSocket(url);
  const c = { ws, room: null, me: null, token: null, denied: null, errors: [], claims: [], pending: new Set() };
  clients.add(c);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'room') {
      c.room = m.room;
      c.me = m.me;
    }
    if (m.t === 'token') c.token = m.token;
    if (m.t === 'error') c.errors.push(m.msg);
    if (m.t === 'denied') c.denied = m;
    if (m.t === 'claimLink') c.claims.push(m);
    for (const notify of [...c.pending]) notify();
  });
  c.until = (check, description, timeout = 8000) => {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        if (!check()) return;
        clearTimeout(timer);
        c.pending.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        c.pending.delete(done);
        const g = c.room?.game;
        const last = [...clients].map(p => ({ me: p.me, last: p.last, errors: p.errors.slice(-2) }));
        reject(new Error('等待超时：' + description + ' ' + JSON.stringify({seq:g?.seq,phase:g?.phase,showing:c.room?.showing,offer:g?.offer,last})));
      }, timeout);
      c.pending.add(done);
    });
  };
  c.send = (m) => { c.last = m; ws.send(JSON.stringify(m)); };
  c.close = async () => {
    if (ws.readyState === 3) return;
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.close();
    await closed;
  };
  return c;
}

async function create() {
  const res = await fetch(new URL('/api/rooms', base), { method: 'POST' });
  assert.equal(res.status, 201, 'room creation');
  const first = await res.json();
  const host = join(first.code, { token: first.token });
  await host.until(() => host.room && host.token, '房主就位');
  assert.equal(first.me, host.me);
  assert.equal(host.me, host.room.hostId);
  assert.equal(host.room.joinUrl, new URL('/p/' + first.code, base).href);
  return host;
}

async function settle(host, people, opts = {}) {
  const seq = host.room.game.seq;
  const observed = new Set();
  while (host.room.showing) {
    const { waitingFor: w, presenterId } = host.room;
    if (w) {
      const target = people.find((p) => p.me === w.pid);
      assert(target);
      assert.equal(
        w.eventIndex,
        host.room.game.events.findIndex((e, i) => i === w.eventIndex && e.pid === w.pid)
      );
      if (opts.timeout && !opts.timeout.used) {
        opts.timeout.used = true;
        // The default 15s playback fallback must not erase a 20s active confirmation.
        const started = Date.now();
        await host.until(() => host.room.waitingFor?.id !== w.id, '真实时限自动确认', 23000);
        assert(Date.now() - started > 17000);
        continue;
      }
      assert(!observed.has(w.id));
      observed.add(w.id);
      target.send({ t: 'ack', seq, id: w.id });
      await host.until(() => host.room.waitingFor?.id !== w.id, '确认推进');
    } else {
      people.find((p) => p.me === presenterId).send({ t: 'played', seq });
      await host.until(() => !host.room.showing, '动画完成');
    }
  }
}

try {
  const host = await create();
  const code = host.room.code;
  let guest = join(code);
  const third = join(code);
  await Promise.all([guest, third].map((p) => p.until(() => p.room && p.token, '玩家入桌')));
  const seats = [host, guest, third];
  guest.send({ t: 'start' });
  await guest.until(() => guest.errors.length, '拒绝非房主开局');
  assert.equal(guest.errors.pop(), '只有房主可以操作');
  host.send({ t: 'pick', code: '1f436' });
  await host.until(() => host.room.seats[0].avatar === '1f436', '选择小狗');
  guest.send({ t: 'pick', code: '1f436' });
  await guest.until(() => guest.errors.length, '拒绝重复角色');
  assert.match(guest.errors.pop(), /已经有人/);
  const extra = [join(code), join(code), join(code)];
  await Promise.all(extra.map((p) => p.until(() => p.room, '坐满六席')));
  const seventh = join(code);
  await seventh.until(() => seventh.denied, '满房');
  assert.equal(seventh.denied.reason, 'full');
  // A fresh room lets us test the full game without waiting for the extra seats' grace period.
  await Promise.all([...seats, ...extra].map((p) => p.close()));

  const H = await create(),
    C = H.room.code;
  let B = join(C),
    D = join(C);
  await Promise.all([B, D].map((p) => p.until(() => p.room && p.token, '新房就位')));
  const oldToken = B.token,
    guestId = B.me;
  await B.close();
  await H.until(() => H.room.seats.find((s) => s.id === guestId)?.online === false, '离线标记');
  const forged = join(C, { claim: guestId });
  await forged.until(() => forged.denied, '拒绝公开 ID 恢复');
  assert.equal(forged.denied.reason, 'claim');
  H.send({ t: 'claimLink', pid: guestId });
  await H.until(() => H.claims.length, '私下生成认领链接');
  assert.equal(D.claims.length, 0);
  const claim = new URL(H.claims.pop().url).searchParams.get('claim');
  B = join(C, { claim });
  await B.until(() => B.room && B.token, '恢复座位');
  assert.equal(B.me, guestId);
  assert.notEqual(B.token, oldToken);
  const stolen = join(C, { token: oldToken }),
    replay = join(C, { claim });
  await Promise.all([stolen, replay].map((p) => p.until(() => p.denied, '旧 token / 认领链接失效')));
  const people = [H, B, D];
  for (const [i, p] of people.entries()) {
    p.send({ t: 'pick', code: ['1f436', '1f43c', '1f680'][i] });
    p.send({ t: 'ready', v: true });
  }
  await H.until(() => H.room.seats.every((s) => s.ready), '全部准备');
  H.send({ t: 'start' });
  await H.until(() => H.room.game, '开局');
  assert.equal(H.room.game.players.find((p) => p.id === H.me).cash, 3000);
  assert.ok(!('deck' in H.room.game));
  assert.ok(!('tokenHash' in H.room.seats[0]));
  await settle(H, people);
  const blocked = people.find((p) => p.me !== current(H.room.game).id);
  blocked.send({ t: 'act', seq: 0, action: { type: 'roll' } });
  await blocked.until(() => blocked.errors.length, '拒绝越权动作');
  assert.match(blocked.errors.pop(), /还没轮到/);
  H.send({ t: 'pause' });
  await H.until(() => H.room.paused, '暂停');
  const active = people.find((p) => p.me === current(H.room.game).id);
  active.send({ t: 'act', action: { type: 'roll' } });
  await active.until(() => active.errors.length, '暂停禁止动作');
  assert.match(active.errors.pop(), /暂停/);
  H.send({ t: 'resume' });
  await H.until(() => !H.room.paused, '继续');

  // All browsers may disconnect. Reopen with their existing tokens and continue the same game.
  const tokens = people.map((p) => p.token),
    snapshot = JSON.stringify(H.room.game.players);
  await Promise.all(people.map((p) => p.close()));
  const bots = tokens.map((token) => join(C, { token }));
  await Promise.all(bots.map((p) => p.until(() => p.room && p.token, '整桌重连')));
  const anchor = bots.find((p) => p.me === H.me);
  assert.equal(JSON.stringify(anchor.room.game.players), snapshot);
  const timeout = { used: false };
  let trades = 0,
    autoEnds = 0,
    refusedStale = false,
    steps = 0;
  const kinds = new Set();
  while (anchor.room.status === 'playing' && steps++ < 2200) {
    const g = anchor.room.game,
      seq = g.seq,
      actor = bots.find((p) => p.me === current(g).id);
    const acts = legalActions(g, actor.me);
    const sendAction = (c, action) => c.send({ t: 'act', seq, action });
    if (!refusedStale) {
      actor.send({ t: 'act', seq: seq + 1, action: { type: 'roll' } });
      await actor.until(() => actor.errors.length, '过期动作');
      assert.match(actor.errors.pop(), /局面已更新/);
      refusedStale = true;
    }
    const offer = acts.find((a) => a.type === 'offer');
    if (!trades && g.offer) {
      const buyers = bots.filter(
        (p) => p.me !== g.offer.from && legalActions(g, p.me).some((a) => a.type === 'acceptOffer')
      );
      if (buyers.length === 2) {
        for (const buyer of buyers) sendAction(buyer, { type: 'acceptOffer' });
        await anchor.until(() => anchor.room.game.seq > seq, '同时抢购只有一笔成交');
        assert.equal(anchor.room.game.seq, seq + 1);
        assert.equal(anchor.room.game.offer, null);
        trades++;
      } else sendAction(actor, { type: 'cancelOffer' });
    } else if (
      !trades &&
      offer &&
      g.players.filter((p) => !p.bankrupt && p.id !== actor.me && p.cash > 0).length === 2
    ) {
      sendAction(actor, { ...offer, price: 1 });
    } else if (anchor.room.autoEnd && !autoEnds) {
      await anchor.until(() => anchor.room.game.seq > seq, '3 秒自动结束');
      autoEnds++;
    } else {
      const action =
        acts.find((a) => a.type === 'buy' && a.build === 2) ||
        acts.find((a) => a.type === 'buy') ||
        acts.find((a) => a.type === 'payDebt') ||
        acts.find((a) => a.type === 'build') ||
        acts.find((a) => a.type === 'roll') ||
        acts.find((a) => a.type === 'skip') ||
        acts.find((a) => a.type === 'end') ||
        acts.find((a) => a.type === 'sell') ||
        acts.find((a) => a.type === 'mortgage') ||
        acts.find((a) => a.type === 'bankrupt');
      assert(action);
      sendAction(actor, action);
    }
    await anchor.until(() => anchor.room.game.seq > seq, '动作落地');
    for (const e of anchor.room.game.events) kinds.add(e.k);
    await settle(anchor, bots, { timeout });
  }
  assert.equal(anchor.room.status, 'ended', '自然结局');
  assert.equal(anchor.room.game.ranking.length, 3);
  assert(trades && autoEnds && refusedStale && timeout.used);
  console.log('完整网页房间通过：', steps, '步，', anchor.room.game.endReason, '；事件', [...kinds].join(', '));
  anchor.send({ t: 'again' });
  await anchor.until(() => anchor.room.status === 'waiting', '再来一局');
  assert(anchor.room.seats.every((s) => !s.ready && s.avatar));
  for (const p of bots) p.send({ t: 'ready', v: true });
  await anchor.until(() => anchor.room.seats.every((s) => s.ready), '第二局准备');
  anchor.send({ t: 'start' });
  await anchor.until(() => anchor.room.game, '第二局开局');
  anchor.send({ t: 'finish' });
  await anchor.until(() => anchor.room.status === 'ended', '提前结算');
  assert.equal(anchor.room.game.endReason, 'host');
  console.log('权限、满员、座位恢复、暂停、超时确认、并发抢购、自动结束、重连及重赛均通过');
} finally {
  for (const c of clients) if (c.ws.readyState < 2) c.ws.close();
}
