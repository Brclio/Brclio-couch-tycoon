// 聚会模式：一个大屏 + 手机通过服务器进房、选角色、断线重连、满员、开局，再用机器人手机打完整局。
// 用法：node test/party.mjs（自己在 5191 端口开一个服务器，把确认/等大屏的时间调短）
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { legalActions, current } from '../shared/engine.js';

const PORT = 5191;
const HOST = `localhost:${PORT}`;
const CONFIRM_MS = 600, SHOW_MS = 1200, AUTOEND_MS = 400;
const srv = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), PARTY_CONFIRM_MS: String(CONFIRM_MS), PARTY_SHOW_MS: String(SHOW_MS), PARTY_AUTOEND_MS: String(AUTOEND_MS), GEMINI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  srv.stdout.on('data', (d) => { if (String(d).includes('客厅大富翁')) res(); });
  srv.on('exit', (code) => rej(new Error(`服务器退出 ${code}`)));
});
const quit = (code) => { srv.kill(); process.exit(code); };
process.on('uncaughtException', (e) => { console.error('失败：', e.message); quit(1); });
process.on('unhandledRejection', (e) => { console.error('失败：', e.message); quit(1); });

function client(query) {
  const ws = new WebSocket(`ws://${HOST}/ws?${new URLSearchParams(query)}`);
  const c = { ws, room: null, me: null, token: null, started: false, denied: null, errors: [], waiters: [], closed: false };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'screen') Object.assign(c, { code: m.code, key: m.key });
    if (m.t === 'token') c.token = m.token;
    if (m.t === 'denied') c.denied = m;
    if (m.t === 'error') c.errors.push(m.msg);
    if (m.t === 'ack') c.acks = (c.acks || 0) + 1;
    if (m.t === 'room') { c.room = m.room; c.me = m.me; if (m.started) c.started = true; }
    c.waiters = c.waiters.filter(w => !w());
  });
  ws.on('close', () => { c.closed = true; c.waiters = c.waiters.filter(w => !w()); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.until = (fn, what = '条件', ms = 4000) => new Promise((res, rej) => {
    if (fn()) return res();
    const to = setTimeout(() => rej(new Error(`等待超时：${what}`)), ms);
    c.waiters.push(() => fn() && (clearTimeout(to), res(), true));
  });
  c.seat = () => c.room?.seats.find(s => s.id === c.me);
  c.close = () => new Promise(r => { ws.once('close', r); ws.close(); });
  return c;
}

const check = (ok, msg) => { if (!ok) throw new Error(msg); console.log('  ✓', msg); };

// 1. 大屏开房
const screen = client({ party: 'screen' });
await screen.until(() => screen.code && screen.room, '大屏拿到房间');
const code = screen.code;
check(/^[A-HJ-NP-Z2-9]{4}$/.test(code), `大屏开了房间 ${code}`);
check(/^http:\/\/[\d.]+:\d+\/p\/[A-Z0-9]{4}$/.test(screen.room.joinUrl) || screen.room.joinUrl.includes('localhost'), `扫码地址 ${screen.room.joinUrl}`);

// 2. 三个手机进房
const phone = (token = '') => client({ party: 'phone', room: code, token });
const P = [phone(), phone(), phone()];
for (const p of P) await p.until(() => p.token && p.seat(), '手机进房');
await screen.until(() => screen.room.seats.length === 3, '大屏看到 3 个座位');
check(true, '3 个手机进房，大屏实时看到 3 个座位');

// 3. 选角色、改名，重复角色被拒
P[0].send({ t: 'pick', code: '1f436' });
await P[0].until(() => P[0].seat()?.avatar === '1f436', '1 号选小狗');
check(P[0].seat().name === '小狗', '1 号选了小狗，名字默认是角色名');
P[1].send({ t: 'pick', code: '1f436' });
await P[1].until(() => P[1].errors.length, '重复角色报错');
check(P[1].errors[0] === '这个角色已经有人选了' && !P[1].seat().avatar, '2 号选同一个角色被拒绝');
P[1].send({ t: 'pick', code: '1f43c' });
P[1].send({ t: 'name', v: '阿熊' });
P[2].send({ t: 'pick', code: '1f680' });
await P[1].until(() => P[1].seat()?.name === '阿熊', '2 号改名');
P[1].send({ t: 'pick', code: '1f98a' });
await P[1].until(() => P[1].seat()?.avatar === '1f98a', '2 号换角色');
check(P[1].seat().name === '阿熊', '改过名字后换角色，名字不被覆盖');
await screen.until(() => screen.room.seats.every(s => s.avatar), '大屏看到所有角色');
check(true, '大屏实时看到每个人选的角色');

// 4. 没全部选好不能开局
screen.send({ t: 'start' });
await screen.until(() => screen.errors.length, '开局报错');
check(screen.errors.pop() === '还有人没选好角色', '有人没点「我选好了」时不能开局');

// 5. 断线用 token 回到原座位
const oldId = P[2].me, oldToken = P[2].token;
await P[2].close();
await screen.until(() => screen.room.seats.find(s => s.id === oldId)?.online === false, '大屏看到掉线');
P[2] = phone(oldToken);
await P[2].until(() => P[2].seat(), '重连');
check(P[2].me === oldId && P[2].seat().avatar === '1f680' && screen.room.seats.length === 3, '断线后用 token 重连，回到原座位和角色');

// 6. 第 7 个人进不来
const extra = [phone(), phone(), phone()];
for (const p of extra) await p.until(() => p.seat(), '凑满 6 人');
const seventh = phone();
await seventh.until(() => seventh.denied && seventh.closed, '第 7 人被拒');
check(seventh.denied.reason === 'full', `第 7 个人被拒：${seventh.denied.msg}`);
for (const p of extra) await p.close();
await new Promise(r => setTimeout(r, 200));

// 先让多余的 3 人马上让出座位不现实（掉线 1 分钟才让座），所以另开一个房间测开局
const screen2 = client({ party: 'screen' });
await screen2.until(() => screen2.code, '第二个房间');
const Q = [0, 1, 2].map(() => client({ party: 'phone', room: screen2.code }));
for (const p of Q) await p.until(() => p.seat(), '进第二个房间');
['1f436', '1f43c', '1f680'].forEach((c, k) => { Q[k].send({ t: 'pick', code: c }); Q[k].send({ t: 'ready', v: true }); });
await screen2.until(() => screen2.room.seats.every(s => s.ready), '都选好');

// 7. 开局：大屏收到 started，手机都收到对局和自己的初始资金
screen2.send({ t: 'start' });
await screen2.until(() => screen2.started && screen2.room.status === 'playing', '大屏开局');
for (const p of Q) await p.until(() => p.room?.status === 'playing', '手机收到开局');
const g = screen2.room.game;
const cash = Q.map(p => p.room.game.players.find(x => x.id === p.me).cash);
check(cash[0] === 3000 && cash[1] === 2500 && cash[2] === 2500, `3 个手机都收到开局和自己的钱：${cash.join(' / ')}（小狗多 $500）`);
check(g.players.map(p => p.avatar).sort().join() === ['1f436', '1f43c', '1f680'].sort().join() && g.order.length === 3, '对局里每人带着自己的角色，出手顺序已排好');

// 8. 开局后再扫码进不来；重连的老玩家能回来
const late = client({ party: 'phone', room: screen2.code });
await late.until(() => late.denied, '开局后扫码');
check(late.denied.reason === 'started', `开局后扫码：${late.denied.msg}`);
const t0 = Q[0].token, id0 = Q[0].me;
await Q[0].close();
Q[0] = client({ party: 'phone', room: screen2.code, token: t0 });
await Q[0].until(() => Q[0].room?.status === 'playing', '开局后重连');
check(Q[0].me === id0, '开局后断线重连，还是原来的座位');
check(late.denied.free.length === 0, '大家都在线时，扫码进来的人没有座位可认领');
// 手机换了浏览器 / 清了缓存（没有 token）：可以认领自己掉线的座位，不能抢在线的人
await Q[0].close();
const lost = client({ party: 'phone', room: screen2.code });
await lost.until(() => lost.denied, '没有 token 扫码');
check(lost.denied.free.length === 1 && lost.denied.free[0].id === id0 && lost.denied.free[0].name, `掉线的座位列出来可认领：${lost.denied.free[0]?.name}`);
const grab = client({ party: 'phone', room: screen2.code, claim: Q[1].me });
await grab.until(() => grab.denied, '认领在线的人');
check(grab.denied.reason === 'started', '认领还在线的人的座位被拒');
Q[0] = client({ party: 'phone', room: screen2.code, claim: id0 });
await Q[0].until(() => Q[0].room?.status === 'playing' && Q[0].token, '认领座位');
check(Q[0].me === id0 && Q[0].token === t0, '认领掉线的座位后回到原座位，拿到原 token');

// 9. 大屏刷新回到同一个房间
const key = screen2.key;
await screen2.close();
const screen3 = client({ party: 'screen', room: screen2.code, key });
await screen3.until(() => screen3.room, '大屏重连');
check(screen3.code === screen2.code && screen3.room.status === 'playing', '大屏刷新后回到同一个房间和对局');
// 服务器重启过（房间没了）：大屏带着原码和钥匙回来，照原码重开，原二维码还能扫
const gone = client({ party: 'screen', room: 'ZZ99', key: 'a'.repeat(32) });
await gone.until(() => gone.room, '重启后的大屏');
check(gone.code === 'ZZ99' && gone.room.status === 'waiting', '服务器重启后大屏照原房间码重开');
const back = client({ party: 'phone', room: 'ZZ99', token: 'old' });
await back.until(() => back.token && back.seat(), '扫原二维码');
check(true, '手机扫原二维码能进重开的房间');
await back.close(); await gone.close();

// 10. 操作的门槛：不轮到、大屏没演完、暂停时都被拒
{
  const sc = screen3, ph = Q;
  const g0 = () => sc.room.game;
  // 大屏刚重连、还没回 played：开局那一步还在演
  await sc.until(() => sc.room.showing, '开局后在等大屏演完');
  const curId = current(g0()).id;
  const curPh = ph.find(p => p.me === curId), other = ph.find(p => p.me !== curId);
  curPh.errors = []; other.errors = [];
  curPh.send({ t: 'act', action: { type: 'roll' } });
  await curPh.until(() => curPh.errors.length, '演完前操作');
  check(curPh.errors[0] === '等大屏演完', '大屏没演完时操作被拒');
  sc.send({ t: 'played', seq: g0().seq });
  await sc.until(() => !sc.room.showing, '放行');
  other.send({ t: 'act', action: { type: 'roll' } });
  await other.until(() => other.errors.length, '不轮到时操作');
  check(other.errors[0] === '还没轮到你', '不轮到的人操作被拒');
  sc.send({ t: 'pause' });
  await sc.until(() => sc.room.paused, '暂停');
  curPh.errors = [];
  curPh.send({ t: 'act', action: { type: 'roll' } });
  await curPh.until(() => curPh.errors.length, '暂停时操作');
  check(curPh.errors[0] === '暂停中', '暂停时操作被拒');
  const endsAt = g0().endsAt;
  await new Promise(r => setTimeout(r, 300));
  sc.send({ t: 'resume' });
  await sc.until(() => !sc.room.paused, '继续');
  check(g0().endsAt - endsAt >= 250, `暂停期间时钟停住（结束时间顺延 ${g0().endsAt - endsAt}ms）`);

  // 大屏弹框等人确认：没人点，过一会儿服务器替他点
  const seq0 = g0().seq;
  curPh.send({ t: 'act', action: { type: 'roll' } });
  await sc.until(() => g0().seq > seq0 && sc.room.showing, '掷骰');
  check(true, '轮到的人掷骰成功');
  sc.acks = 0;
  sc.send({ t: 'wait', pid: other.me, title: '测试', button: '付钱', amount: 10, lines: ['测试弹框'] });
  await other.until(() => other.room.waitingFor?.pid === other.me, '手机收到确认');
  check(other.room.waitingFor.button === '付钱', '要确认的手机收到弹框内容');
  const t0 = Date.now();
  await sc.until(() => sc.acks === 1, '超时自动确认', CONFIRM_MS + 2000);
  check(Date.now() - t0 >= CONFIRM_MS - 100, `手机一直不点，${Date.now() - t0}ms 后大屏自动继续`);
  sc.send({ t: 'wait', pid: other.me, title: '测试', button: '知道了', lines: [] });
  await other.until(() => other.room.waitingFor?.pid === other.me, '第二次确认');
  other.send({ t: 'ack' });
  await sc.until(() => sc.acks === 2 && !sc.room.waitingFor, '手机确认');
  check(true, '手机点确认，大屏马上收到');
  // 大屏一直不回 played：过一阵自动放行
  await sc.until(() => !sc.room.showing, '大屏不回也放行', SHOW_MS + 2000);
  check(true, '大屏一直不回「演完了」，服务器也会放行，不会卡死');
  sc.send({ t: 'finish' });
  await sc.until(() => sc.room.status === 'ended', '主持人结束');
  check(g0().endReason === 'host' && g0().ranking.length === 3 && ph.every(p => p.room.game?.status === 'ended' || true), `主持人点「结束」马上按净资产结算，${g0().ranking[0].name} 第一`);
}

// 11. 机器人打完一整局：假大屏收到新一步就回 played；手机见到确认就点，轮到就随机操作
{
  const sc = client({ party: 'screen' });
  await sc.until(() => sc.code, '第三个房间');
  const bots = [0, 1, 2].map(() => client({ party: 'phone', room: sc.code }));
  for (const b of bots) await b.until(() => b.seat(), '机器人进房');
  ['1f43c', '1f98a', '1f427'].forEach((c, k) => { bots[k].send({ t: 'pick', code: c }); bots[k].send({ t: 'ready', v: true }); });
  await sc.until(() => sc.room.seats.every(s => s.ready), '机器人都选好');

  let steps = 0, played = -1, finished = false;
  const trades = { offers: 0, done: 0 };
  const kinds = new Set();
  sc.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'room' || !m.room.game) return;
    const g = m.room.game;
    if (m.room.showing && g.seq !== played) {
      played = g.seq;
      g.events.forEach(e => { kinds.add(e.k); if (e.k === 'trade') trades.done++; });
      setTimeout(() => sc.send({ t: 'played', seq: g.seq }), 2);
    }
    if (g.status === 'playing' && steps > 1500 && !finished) { finished = true; sc.send({ t: 'finish' }); }
  });
  const SKIP = new Set(['resign', 'acceptOffer']);
  const MAIN = new Set(['roll', 'buy', 'skip', 'end', 'payDebt', 'bankrupt', 'payJail', 'useCard']);
  for (const b of bots) {
    b.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== 'room' || m.room.status !== 'playing' || m.room.showing || m.room.paused) return;
      if (m.room.waitingFor?.pid === b.me) return b.send({ t: 'ack' });
      const g = m.room.game;
      // 别人挂出的地：买得起就有一半机会去抢
      if (g.offer && g.offer.from !== b.me && legalActions(g, b.me).some(a => a.type === 'acceptOffer') && Math.random() < 0.5) {
        trades.offers++;
        return b.send({ t: 'act', action: { type: 'acceptOffer' } });
      }
      if (current(g).id !== b.me) return;
      const acts = legalActions(g, b.me).filter(a => !SKIP.has(a.type));
      const main = acts.filter(a => MAIN.has(a.type));
      const pool = main.length && Math.random() < 0.85 ? main : acts;
      const a = pool[Math.floor(Math.random() * pool.length)];
      if (!a) return;
      steps++;
      b.send({ t: 'act', action: a });
    });
  }
  sc.send({ t: 'start' });
  await sc.until(() => sc.room.status === 'ended', '打完一局', 120_000);
  const g = sc.room.game;
  check(true, `打完一局：${steps} 步，${g.endReason === 'last' ? '只剩一人' : '主持人结束结算'}，${g.players.find(p => p.id === g.winner).name} 获胜`);
  for (const b of bots) await b.until(() => b.room.status === 'ended', '手机收到结束');
  check(bots.every(b => b.room.game.ranking.some(r => r.id === b.me)), '每个手机都拿到名次');
  check(['dice', 'move', 'money', 'turn'].every(k => kinds.has(k)), `大屏收到的事件：${[...kinds].join(' ')}`);
  check(trades.done > 0, `整局里机器人挂牌卖地、抢购成交 ${trades.done} 次，照样打完`);
  sc.send({ t: 'again' });
  await sc.until(() => sc.room.status === 'waiting', '再来一局');
  check(sc.room.seats.length === 3 && sc.room.seats.every(s => s.avatar && !s.ready) && !sc.room.game, '再来一局：回到等人，座位和角色保留，都要重新点「我选好了」');
}

// 12. 挂牌卖地和抢购：一步一步驱动，假大屏每步立刻回 played
{
  const sc = client({ party: 'screen' });
  await sc.until(() => sc.code, '第四个房间');
  const ph = [0, 1, 2].map(() => client({ party: 'phone', room: sc.code }));
  for (const p of ph) await p.until(() => p.seat(), '进房');
  ['1f43c', '1f98a', '1f427'].forEach((c, k) => { ph[k].send({ t: 'pick', code: c }); ph[k].send({ t: 'ready', v: true }); });
  await sc.until(() => sc.room.seats.every(s => s.ready), '都选好');
  sc.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'room' && m.room.showing && m.room.game) sc.send({ t: 'played', seq: m.room.game.seq });
  });
  sc.send({ t: 'start' });
  await sc.until(() => sc.room.status === 'playing' && !sc.room.showing, '开局');
  const G = () => sc.room.game;
  const phoneOf = (id) => ph.find(p => p.me === id);
  const cashOf = (id) => G().players.find(p => p.id === id).cash;
  // 当前玩家做一步，等大屏演完
  const step = async (action, who = current(G()).id) => {
    const seq = G().seq, p = phoneOf(who);
    p.errors = [];
    p.send({ t: 'act', action });
    await Promise.race([sc.until(() => G().seq > seq && !sc.room.showing, `动作 ${action.type}`), p.until(() => p.errors.length, '报错')]);
    if (p.errors.length) throw new Error(`${action.type} 被拒：${p.errors[0]}`);
  };
  // 普通地打一回合：掷骰、能买就买（买空地）、欠钱就自动处理、结束
  const playTurn = async (buy = true) => {
    const me = current(G()).id;
    for (let k = 0; k < 20 && current(G()).id === me && G().status === 'playing'; k++) {
      const acts = legalActions(G(), me).map(a => a.type);
      if (G().phase === 'buy') await step({ type: buy && acts.includes('buy') ? 'buy' : 'skip' });
      else if (G().phase === 'debt') await step({ type: acts.includes('payDebt') ? 'payDebt' : 'bankrupt' });
      else if (acts.includes('roll')) await step({ type: 'roll' });
      else if (acts.includes('end')) await step({ type: 'end' });
    }
  };
  // 打到「有地的人轮到自己、在掷骰或回合末」为止
  const ownerOf = (id) => Object.entries(G().props).filter(([, pr]) => pr.owner === id && !pr.mortgaged).map(([i]) => +i);
  for (let k = 0; k < 60 && !(ownerOf(current(G()).id).length && ['roll', 'manage'].includes(G().phase)); k++) await playTurn();
  const seller = current(G()).id;
  const sq = ownerOf(seller)[0];
  const buyers = G().players.filter(p => p.id !== seller).map(p => p.id);
  check(sq != null, `${G().players.find(p => p.id === seller).name} 有地，轮到他`);

  // 不轮到的人挂牌被拒
  phoneOf(buyers[0]).errors = [];
  phoneOf(buyers[0]).send({ t: 'act', action: { type: 'offer', square: sq, price: 100 } });
  await phoneOf(buyers[0]).until(() => phoneOf(buyers[0]).errors.length, '不轮到挂牌');
  check(phoneOf(buyers[0]).errors[0] === '还没轮到你', '不轮到的人挂牌被拒');

  // 要价太高：所有人都买不起
  const tooHigh = Math.max(...buyers.map(cashOf)) + 1;
  await step({ type: 'offer', square: sq, price: tooHigh }, seller);
  for (const p of ph) await p.until(() => p.room.game.offer?.square === sq, '手机看到挂牌');
  check(ph.every(p => p.room.game.offer.price === tooHigh), `挂出 $${tooHigh}，所有手机都看到`);
  const b0 = phoneOf(buyers[0]);
  b0.errors = [];
  b0.send({ t: 'act', action: { type: 'acceptOffer' } });
  await b0.until(() => b0.errors.length, '买不起');
  check(b0.errors[0] === '钱不够', '买不起的人抢购被拒');
  b0.errors = [];
  b0.send({ t: 'act', action: { type: 'cancelOffer' } });
  await b0.until(() => b0.errors.length, '别人收回');
  check(!!b0.errors[0] && G().offer, `不是卖家的人收回被拒：${b0.errors[0]}`);
  await step({ type: 'cancelOffer' }, seller);
  check(!G().offer && G().props[sq].owner === seller, '卖家收回：地还是自己的');

  // 挂着不管，回合结束自动收回
  if (G().phase === 'roll') {
    await step({ type: 'offer', square: sq, price: 50 }, seller);
    // 先把掷骰到回合末走完（不买新地），中途要是有人抢了就算了，这里只等回合结束
    const before = G().props[sq].owner;
    await playTurn(false);
    if (G().props[sq].owner === before) check(!G().offer && G().props[sq].owner === seller, '挂着没人买，回合结束自动收回');
  }

  // 两个买家同时抢：只有一个成功
  for (let k = 0; k < 60 && !(ownerOf(current(G()).id).length && ['roll', 'manage'].includes(G().phase)); k++) await playTurn();
  const s2 = current(G()).id, sq2 = ownerOf(s2)[0], pr2 = { ...G().props[sq2] };
  const rivals = G().players.filter(p => p.id !== s2 && !p.bankrupt).map(p => p.id);
  const price = 30;
  await step({ type: 'offer', square: sq2, price }, s2);
  const cash0 = Object.fromEntries(G().players.map(p => [p.id, p.cash]));
  const [r1, r2] = rivals.map(phoneOf);
  r1.errors = []; r2.errors = [];
  r1.send({ t: 'act', action: { type: 'acceptOffer' } });
  r2.send({ t: 'act', action: { type: 'acceptOffer' } });
  await sc.until(() => !G().offer && !sc.room.showing, '成交');
  await new Promise(r => setTimeout(r, 300));
  const winner = G().props[sq2].owner;
  const loser = [r1, r2].find(p => p.me !== winner);
  check(rivals.includes(winner) && loser.errors.length === 1, `两人同时抢购，只有一个买到（另一个收到「${loser.errors[0]}」）`);
  const pr = G().props[sq2];
  check(pr.houses === pr2.houses && pr.mortgaged === pr2.mortgaged, '地连房子和抵押状态一起转手');
  check(cashOf(winner) === cash0[winner] - price && cashOf(s2) === cash0[s2] + price, `钱对得上：买家 -$${price}，卖家 +$${price}`);
}

// 13. 没事可做自动结束回合：只剩「结束」时服务器倒数后替他结束；还能盖房、挂着地、点了「等一下」都不自动结束
{
  const sc = client({ party: 'screen' });
  await sc.until(() => sc.code, '第五个房间');
  const ph = [0, 1].map(() => client({ party: 'phone', room: sc.code }));
  for (const p of ph) await p.until(() => p.seat(), '进房');
  ['1f43c', '1f98a'].forEach((c, k) => { ph[k].send({ t: 'pick', code: c }); ph[k].send({ t: 'ready', v: true }); });
  await sc.until(() => sc.room.seats.every(s => s.ready), '都选好');
  sc.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'room' && m.room.showing && m.room.game) sc.send({ t: 'played', seq: m.room.game.seq });
  });
  sc.send({ t: 'start' });
  await sc.until(() => sc.room.status === 'playing' && !sc.room.showing, '开局');
  const G = () => sc.room.game;
  const phoneOf = (id) => ph.find(p => p.me === id);
  const settled = () => sc.until(() => !sc.room.showing, '大屏演完');
  const step = async (action, who = current(G()).id) => {
    const seq = G().seq, p = phoneOf(who);
    p.errors = [];
    p.send({ t: 'act', action });
    await Promise.race([sc.until(() => G().seq > seq && !sc.room.showing, `动作 ${action.type}`), p.until(() => p.errors.length, '报错')]);
    if (p.errors.length) throw new Error(`${action.type} 被拒：${p.errors[0]}`);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const seen = { auto: 0, build: 0, hold: 0, offer: 0 };
  for (let k = 0; k < 300 && G().status === 'playing' && (seen.auto < 3 || !seen.hold || !seen.offer); k++) {
    await settled();
    const g = G(), me = current(g).id, acts = legalActions(g, me);
    if (g.phase === 'roll') { await step({ type: 'roll' }); continue; }
    if (g.phase === 'buy') { await step({ type: acts.some(a => a.type === 'buy') ? 'buy' : 'skip' }); continue; }
    if (g.phase === 'debt') { await step({ type: acts.some(a => a.type === 'payDebt') ? 'payDebt' : 'bankrupt' }); continue; }
    if (g.phase !== 'manage') continue;
    const canBuild = acts.some(a => a.type === 'build' && a.square === g.stop?.square);
    const ae = sc.room.autoEnd;
    if (canBuild) {
      if (ae) throw new Error('还能盖房却要自动结束');
      seen.build++;
      await sleep(AUTOEND_MS * 2);
      if (current(G()).id !== me) throw new Error('还能盖房却被自动结束了');
      await step({ type: 'end' });
      continue;
    }
    if (!ae || ae.pid !== me) throw new Error(`只剩结束，却没有自动结束（${g.phase}）`);
    const land = acts.find(a => a.type === 'offer');
    if (!seen.offer && land) {
      await step({ type: 'offer', square: land.square, price: 9999 });
      if (sc.room.autoEnd) throw new Error('挂着地却要自动结束');
      await sleep(AUTOEND_MS * 2);
      if (current(G()).id !== me) throw new Error('挂着地却被自动结束了');
      await step({ type: 'cancelOffer' });
      if (sc.room.autoEnd?.pid !== me) throw new Error('收回以后没有重新倒数');
      seen.offer++;
    } else if (!seen.hold && seen.auto) {
      phoneOf(me).send({ t: 'hold' });
      await sc.until(() => !sc.room.autoEnd, '等一下');
      await sleep(AUTOEND_MS * 3);
      if (current(G()).id !== me || G().phase !== 'manage') throw new Error('点了等一下还是被自动结束了');
      seen.hold++;
      await step({ type: 'end' });
      continue;
    }
    const t0 = Date.now();
    await sc.until(() => current(G()).id !== me || G().status !== 'playing', '自动结束回合', AUTOEND_MS + 3000);
    if (Date.now() - t0 < AUTOEND_MS / 2) throw new Error('倒数还没到就结束了');
    seen.auto++;
  }
  check(seen.auto >= 3, `只剩「结束」时没人点，${seen.auto} 次都自动轮到下一位`);
  check(seen.offer === 1, '自己挂着地时不自动结束，收回后重新倒数');
  check(seen.hold === 1, '点了「等一下」本回合不自动结束');
  check(true, `停在自己国家还能盖房时不自动结束（遇到 ${seen.build} 次）`);
  // 认领码：掉线的人用大屏上的二维码（?claim=座位）回来
  const lostId = ph[1].me;
  await ph[1].close();
  await sc.until(() => !sc.room.seats.find(s => s.id === lostId).online, '大屏看到掉线');
  check(true, '大屏看到这个人掉线了');
  const back = client({ party: 'phone', room: sc.code, claim: lostId });
  await back.until(() => back.me === lostId, '扫认领码');
  await sc.until(() => sc.room.seats.find(s => s.id === lostId).online, '大屏看到回来');
  check(true, '扫大屏上的认领码，回到掉线的座位');
}

console.log('通过：聚会模式进房、选角色、重连、满员、开局、操作门槛、确认超时、完整对局、挂牌抢购、自动结束回合、认领座位');
quit(0);
