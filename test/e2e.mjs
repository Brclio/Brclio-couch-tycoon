// 端到端：两个账号通过服务器建桌（上锁）→ 邀请码加入 → 开局 → 随机打完 → 再来一局。
// 用法：先 npm start，再 node test/e2e.mjs
import WebSocket from 'ws';
import { legalActions, current } from '../shared/engine.js';

const BASE = 'http://localhost:5178';
const rnd = Math.random().toString(36).slice(2, 7);

async function account(name) {
  const body = JSON.stringify({ name, password: 'test1234' });
  let r = await fetch(`${BASE}/api/register`, { method: 'POST', body }).then(r => r.json());
  if (r.error) r = await fetch(`${BASE}/api/login`, { method: 'POST', body }).then(r => r.json());
  if (r.error) throw new Error(r.error);
  return r;
}

function client(token) {
  const ws = new WebSocket(`ws://localhost:5178/ws?token=${token}`);
  const c = { ws, table: null, lobby: [], errors: [], waiters: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'table') c.table = m.table;
    if (m.t === 'lobby') c.lobby = m.tables;
    if (m.t === 'error') c.errors.push(m.msg);
    c.waiters = c.waiters.filter(w => !w());
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.until = (fn, ms = 5000) => new Promise((res, rej) => {
    if (fn()) return res();
    const to = setTimeout(() => rej(new Error('等待超时')), ms);
    c.waiters.push(() => fn() && (clearTimeout(to), res(), true));
  });
  return new Promise(r => ws.on('open', () => r(c)));
}

const A = await client((await account(`甲${rnd}`)).token);
const B = await client((await account(`乙${rnd}`)).token);

A.send({ t: 'create', name: '测试桌', max: 2, duration: 30, locked: true });
await A.until(() => A.table?.code);
const code = A.table.code;
console.log('建桌成功，邀请码', code);

await B.until(() => B.lobby.some(t => t.id === A.table.id && t.locked));
B.send({ t: 'join', tableId: A.table.id });
await B.until(() => B.errors.length);
console.log('不带码加入上锁桌被拒：', B.errors.pop());

B.send({ t: 'join', code: code.toLowerCase() });
await B.until(() => B.table?.id === A.table.id);
console.log('邀请码加入成功');

A.send({ t: 'start' });
await A.until(() => A.errors.length);
console.log('没准备不能开局：', A.errors.pop());

B.send({ t: 'ready', v: true });
await A.until(() => A.table.seats.every(s => s.id === A.table.hostId || s.ready));
A.send({ t: 'start' });
await A.until(() => A.table.status === 'playing');
console.log('开局');

let steps = 0;
const ids = Object.fromEntries([[A.table.hostId, A], [A.table.seats.find(s => s.id !== A.table.hostId).id, B]]);
while (A.table.status === 'playing') {
  const g = A.table.game;
  const pid = current(g).id;
  const c = ids[pid];
  const acts = legalActions(g, pid).filter(a => a.type !== 'resign');
  const prefer = acts.filter(a => ['buy', 'build', 'payDebt'].includes(a.type));
  const pool = prefer.length && Math.random() < 0.8 ? prefer : acts;
  const seq = g.seq;
  c.send({ t: 'act', action: pool[Math.floor(Math.random() * pool.length)] });
  await A.until(() => A.table.game.seq !== seq || A.table.status !== 'playing');
  if (++steps > 20000) { A.send({ t: 'act', action: { type: 'resign' } }); }
}
if (A.errors.length || B.errors.length) throw new Error('对局中出现错误：' + [...A.errors, ...B.errors].join(' / '));
const g = A.table.game;
console.log(`对局结束：${steps} 步，${g.players.find(p => p.id === g.winner).name} 获胜（${g.endReason}）`);

A.send({ t: 'again' });
await B.until(() => B.table.status === 'waiting' && !B.table.game);
console.log('再来一局：回到等待状态，两人都在');

B.send({ t: 'leave' });
await B.until(() => B.table === null);
A.send({ t: 'leave' });
await A.until(() => A.table === null);
await A.until(() => !A.lobby.some(t => t.name === '测试桌'));
console.log('两人离开，桌子解散。全部通过');
process.exit(0);
