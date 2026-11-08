// Run against a local Cloudflare Worker: node test/cloud-lobby.mjs http://127.0.0.1:8787
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { current } from '../shared/engine.js';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
const sockets = new Set();
const suffix = Math.random().toString(36).slice(2, 8);

async function auth(path, value) {
  const response = await fetch(new URL('/api/' + path, base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  return { status: response.status, body: await response.json() };
}

let stage = '连接';

function client(token) {
  const url = new URL('/ws', base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  sockets.add(ws);
  ws.once('close', () => sockets.delete(ws));
  const events = [];
  const waiting = new Set();
  ws.on('message', raw => {
    events.push(JSON.parse(raw));
    for (const notify of [...waiting]) notify();
  });
  return {
    ws, events,
    send: value => ws.send(JSON.stringify(value)),
    async next(test, from = 0, timeout = 10000) {
      const found = () => events.slice(from).find(test);
      if (found()) return found();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(check); reject(new Error('等待消息超时：' + stage + '，最后消息类型 ' + events.at(-1)?.t)); }, timeout);
        function check() {
          const message = found();
          if (!message) return;
          waiting.delete(check); clearTimeout(timer); resolve(message);
        }
        waiting.add(check);
      });
    },
    async command(message, test, observe = this) {
      const from = observe.events.length;
      this.send(message);
      return observe.next(test, from);
    },
    async close() {
      const closed = once(ws, 'close');
      ws.close(); await closed;
    },
  };
}

const isError = m => m.t === 'error';
const table = predicate => m => m.t === 'table' && m.table && predicate(m.table);
const isWaiting = table(t => t.status === 'waiting');
const isPlaying = table(t => t.status === 'playing');

try {
  assert.equal((await auth('login', null)).status, 400);
  assert.equal((await auth('login', { name: 'constructor', password: 'wrong' })).status, 401);
  const people = [];
  for (let i = 0; i < 3; i++) {
    const credentials = { name: '云' + i + suffix, password: 'local-test' };
    const registration = await auth('register', credentials);
    assert.equal(registration.status, 200);
    assert.deepEqual(Object.keys(registration.body.user).sort(), ['id', 'name']);
    assert.equal((await auth('register', credentials)).status, 400);
    assert.equal((await auth('login', { ...credentials, password: 'wrong' })).status, 401);
    const login = await auth('login', credentials);
    assert.equal(login.status, 200);
    assert.notEqual(login.body.token, registration.body.token);
    const person = { ...login.body, client: client(login.body.token) };
    assert.equal((await person.client.next(m => m.t === 'auth')).ok, true);
    await person.client.next(m => m.t === 'table' && m.table === null);
    people.push(person);
  }
  const invalid = client('1234');
  assert.equal((await invalid.next(m => m.t === 'auth')).ok, false);
  console.log('✓ 注册登录、重复昵称、畸形请求、无效 token、隐私字段');

  const [host, guest, outsider] = people.map(p => p.client);
  const opened = (await host.command({ t: 'create', name: '网页大厅', locked: true, max: 2, duration: 30 }, isWaiting)).table;
  assert.match(opened.code, /^[A-HJ-NP-Z2-9]{6}$/);
  const publicTables = (await guest.next(m => m.t === 'lobby' && m.tables.some(t => t.id === opened.id))).tables;
  assert.equal(publicTables.find(t => t.id === opened.id).code, undefined);
  await guest.command({ t: 'join', tableId: opened.id }, isError);
  await guest.command({ t: 'join', code: opened.code.toLowerCase() }, isWaiting);
  await outsider.command({ t: 'join', code: opened.code }, isError);
  await host.command({ t: 'start' }, isError);
  await guest.command({ t: 'ready', v: true }, table(t => t.seats.some(s => s.ready)), host);
  await guest.command({ t: 'lock', v: false }, isError);
  const started = (await host.command({ t: 'start' }, isPlaying)).table.game;
  assert.equal(started.deck, undefined);
  assert.equal(started.discard, undefined);
  assert.equal(started.players.length, 2);
  console.log('✓ 密桌、邀请码、满员、准备门槛、房主权限、牌堆隐藏');

  const acting = people.find(p => p.user.id === current(started).id);
  const observing = people.find(p => p !== acting && p !== people[2]);
  await observing.client.command({ t: 'act', action: { type: 'roll' } }, isError);
  const beforeDrop = observing.client.events.length;
  stage = '断线';
  await acting.client.close();
  await observing.client.next(table(t => t.seats.some(s => s.id === acting.user.id && !s.online)), beforeDrop);
  stage = '断线托管';
  const automatic = (await observing.client.next(table(t => t.game.seq > started.seq), beforeDrop)).table;
  stage = '重连';
  acting.client = client(acting.token);
  const restored = (await acting.client.next(isPlaying)).table;
  assert.equal(restored.id, opened.id);
  assert.ok(restored.game.seq >= automatic.game.seq);
  assert.equal(restored.game.players.length, 2);
  stage = '结束';
  const actor = people.find(p => p.user.id === current(restored.game).id);
  await actor.client.command({ t: 'act', seq: restored.game.seq - 1, action: { type: 'resign' } }, isError);
  const ended = (await actor.client.command({ t: 'act', action: { type: 'resign' } }, table(t => t.status === 'ended'))).table;
  assert.equal(ended.game.ranking.length, 2);
  stage = '再开一局';
  const nextGame = (await people[0].client.command({ t: 'again' }, isWaiting, people[1].client)).table;
  assert.equal(nextGame.game, null);
  assert.equal(nextGame.seats.every(s => !s.ready), true);
  stage = '离桌';
  const migrated = (await people[0].client.command({ t: 'leave' }, table(t => t.seats.length === 1), people[1].client)).table;
  assert.equal(migrated.hostId, people[1].user.id);
  await people[1].client.command({ t: 'leave' }, m => m.t === 'table' && m.table === null);
  const returning = client(people[1].token);
  const { lastResult } = await returning.next(m => m.t === 'auth');
  assert.equal(lastResult.matchId, ended.matchId);
  assert.equal(lastResult.winner, ended.game.winner);
  assert.deepEqual(lastResult.ranking, ended.game.ranking);
  console.log('✓ 非本人回合被拒、断线托管、原桌重连、陈旧动作、结算、再开局、房主移交、离桌后恢复成绩');
} finally {
  for (const socket of sockets) socket.terminate();
}
