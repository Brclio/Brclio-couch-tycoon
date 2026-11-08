// Deterministic rule and alarm scenarios at the same message entry point used by workerd.
// The full-network and empty-storage counterparts are cloud-room.mjs and cloud-recovery.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestRoom } from '../cloud/room.js';
import { createGame, current } from '../shared/engine.js';

function fixture(t) {
  let now = 2_000_000,
    alarm = null;
  t.mock.method(Date, 'now', () => now);
  const seats = ['a', 'b', 'c'].map((id) => ({ id, name: id, avatar: id, ready: true, offlineSince: null }));
  const sockets = seats.map((seat) => ({
    readyState: 1,
    deserializeAttachment: () => ({ pid: seat.id }),
    messages: [],
    send(raw) {
      this.messages.push(JSON.parse(raw));
    },
    close() {
      this.readyState = 3;
    },
  }));
  const ctx = {
    getWebSockets: () => sockets,
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (at) => {
        alarm = at;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  };
  const object = new GuestRoom(ctx, {});
  object.store = { save: async () => {}, getNextFlushAt: async () => null };
  object.room = {
    code: 'TEST',
    origin: 'https://test.invalid',
    seats,
    hostId: 'a',
    status: 'playing',
    pausedAt: null,
    emptySince: null,
    autoEnd: null,
    playback: null,
    hold: null,
    game: createGame(seats, { shuffleOrder: false }, { now, rng: () => 0 }),
  };
  const send = async (pid, input) =>
    object.webSocketMessage(
      sockets.find((s) => s.deserializeAttachment().pid === pid),
      JSON.stringify(input)
    );
  return {
    get r() {
      return object.room;
    },
    sockets,
    send,
    advance: (ms) => {
      now += ms;
    },
    alarm: () => object.alarm(),
    close: (pid) =>
      object.webSocketClose(
        sockets.find((s) => s.deserializeAttachment().pid === pid),
        1000,
        ''
      ),
    async act(pid, action) {
      await send(pid, { t: 'act', action, seq: object.room.game.seq });
    },
    async played() {
      const p = object.room.playback;
      if (p) await send(p.pid, { t: 'played', seq: p.seq });
    },
  };
}

test('两次停留建造升级酒店、售房、抵押、非当值玩家买入抵押地产', async (t) => {
  const f = fixture(t),
    g = f.r.game;
  g.phase = 'manage';
  g.stop = { square: 1, built: 0 };
  g.players[0].pos = 1;
  g.props[1] = { owner: 'a', houses: 3, mortgaged: false };
  const openingCash = g.players[0].cash;
  for (let i = 0; i < 2; i++) {
    await f.act('a', { type: 'build', square: 1 });
    await f.played();
  }
  assert.equal(f.r.game.players[0].cash, openingCash - 100);
  assert.equal(f.r.game.props[1].houses, 5);
  assert.equal(f.r.game.stop.built, 2);
  assert.ok(f.r.autoEnd);
  await f.send('a', { t: 'hold' });
  assert.equal(f.r.autoEnd, null);
  for (let i = 0; i < 5; i++) {
    await f.act('a', { type: 'sell', square: 1 });
    await f.played();
  }
  assert.equal(f.r.game.players[0].cash, openingCash + 25);
  await f.act('a', { type: 'mortgage', square: 1 });
  await f.played();
  assert.equal(f.r.game.props[1].mortgaged, true);
  assert.equal(f.r.game.players[0].cash, openingCash + 55);
  await f.act('a', { type: 'offer', square: 1, price: 250 });
  await f.played();
  assert.equal(f.r.autoEnd, null);
  await f.act('b', { type: 'acceptOffer' });
  await f.played();
  assert.equal(f.r.game.props[1].owner, 'b');
  assert.equal(f.r.game.props[1].mortgaged, true);
  assert.equal(f.r.game.players[1].cash, 2250);
  assert.equal(current(f.r.game).id, 'a');
  f.advance(3500);
  await f.alarm();
  assert.equal(current(f.r.game).id, 'a', '主动等一下后不自动结束');
});

test('抽到前往机场卡、双倍租金按事件分别确认；过期 ack 无效，暂停期间两种时限均冻结', async (t) => {
  const f = fixture(t),
    g = f.r.game;
  g.deck = [3, ...g.deck.filter((id) => id !== 3)];
  g.props[9] = { owner: 'b', houses: 0, mortgaged: false };
  t.mock.method(Math, 'random', () => 0); // 1+1，落在 2 号命运格。
  await f.act('a', { type: 'roll' });
  assert.equal(f.r.game.players[0].cash, 2450);
  assert.equal(f.r.game.players[1].cash, 2550);
  const card = f.r.playback.prompts[0];
  assert.equal(f.r.game.events[card.eventIndex].k, 'card');
  await f.played();
  assert.ok(f.r.playback, '动画播完仍等待真实玩家确认');
  await f.send('b', { t: 'ack', seq: card.seq, id: card.id });
  assert.equal(f.r.playback.prompts[0].id, card.id);
  await f.send('a', { t: 'ack', seq: card.seq, id: card.id });
  const rent = f.r.playback.prompts[0];
  assert.equal(f.r.game.events[rent.eventIndex].kind, 'rent');
  assert.equal(rent.amount, 50);
  await f.send('a', { t: 'ack', seq: card.seq, id: card.id });
  assert.equal(f.r.playback.prompts[0].id, rent.id);
  f.advance(15500);
  await f.alarm();
  assert.equal(f.r.playback.prompts[0].id, rent.id);
  await f.send('a', { t: 'pause' });
  f.advance(60000);
  await f.alarm();
  assert.equal(f.r.playback.prompts[0].id, rent.id);
  await f.send('a', { t: 'resume' });
  f.advance(4600);
  await f.alarm();
  assert.equal(f.r.playback, null);
  assert.equal(f.r.game.deadline, Date.now() + 30000);
});

test('掉线玩家三秒托管，房主离线满一分钟时在线座位接任', async (t) => {
  const f = fixture(t);
  f.r.game.phase = 'manage';
  await f.close('a');
  f.advance(2999);
  await f.alarm();
  assert.equal(current(f.r.game).id, 'a');
  f.advance(1);
  await f.alarm();
  assert.equal(current(f.r.game).id, 'b');
  assert.equal(f.r.playback.pid, 'b');
  await f.played();
  f.advance(57000);
  await f.alarm();
  assert.equal(f.r.hostId, 'b');
  await f.send('b', { t: 'pause' });
  assert.equal(f.r.pausedAt, Date.now());
});
