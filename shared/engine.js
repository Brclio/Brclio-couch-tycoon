// 规则引擎：纯函数，服务器和前端共用。所有数字见 规则.md。
// act() 直接修改 state；非法动作抛出 RuleError。ctx = { now, rng }。

import {
  SQUARES, GROUPS, CARDS, BOARD_SIZE, AIRPORTS, START_CASH, AVATAR_BONUS, GO_SALARY, JAIL_POS, JAIL_FINE, TURN_SECONDS, BUILD_PER_STOP,
  PLAYER_COLORS, groupMembers, baseRent, HOUSE_MULT, AIRPORT_RENT, UTILITY_MULT,
  mortgageValue, unmortgageCost,
} from './board.js';

export class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

const MAX_LOG = 60;

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createGame(players, { durationMin = 60, shuffleOrder = true } = {}, ctx) {
  const state = {
    status: 'playing',
    players: players.map((p, i) => ({
      id: p.id, name: p.name, avatar: p.avatar || null, color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      cash: START_CASH, pos: 0, inJail: false, jailTurns: 0, jailCards: 0,
      owed: [], bankrupt: false,
    })),
    props: {},          // 格子序号 -> { owner, houses(0–5，5=酒店), mortgaged }
    order: shuffleOrder ? shuffle(players.map((_, i) => i), ctx.rng) : players.map((_, i) => i),
    turnIdx: 0,
    phase: 'roll',      // roll | buy | manage | debt | ended
    rollAgain: false,
    doubles: 0,
    dice: null,
    pending: null,      // { square } 等待买地
    offer: null,        // { square, price, from } 正在出售给其他玩家的地
    stop: null,         // { square, built } 本次停留的格子，只能在这里盖房
    afterDebt: null,
    deck: shuffle(CARDS.map(c => c.id), ctx.rng),
    discard: [],
    card: null,         // 最近一张卡 { id, text, by }
    log: [],
    events: [],         // 本次动作产生的事件，界面按顺序播放动画
    round: 1,
    bankNet: 0,         // 银行净发出的钱，对账用
    bankOut: 0,         // 本局银行一共发出
    bankIn: 0,          // 本局银行一共收回
    startCash: START_CASH,
    startedAt: ctx.now,
    endsAt: durationMin ? ctx.now + durationMin * 60000 : null,
    deadline: ctx.now + TURN_SECONDS * 1000,
    winner: null,
    endReason: null,
    seq: 0,
  };
  log(state, ctx, `出手顺序：${state.order.map(i => state.players[i].name).join(' → ')}`);
  for (const p of state.players) {
    const bonus = AVATAR_BONUS[p.avatar] || 0;
    if (!bonus) continue;
    bank(state, p, bonus, '角色奖励');
    log(state, ctx, `${p.name} 的角色奖励：开局多拿 $${bonus}`);
  }
  return state;
}

// ---------- 查询 ----------

export const current = (s) => s.players[s.order[s.turnIdx]];
export const player = (s, id) => s.players.find(p => p.id === id);
export const alive = (s) => s.players.filter(p => !p.bankrupt);
export const totalOwed = (p) => p.owed.reduce((a, o) => a + o.amount, 0);

export function ownsGroup(s, ownerId, group) {
  return groupMembers(group).every(i => s.props[i]?.owner === ownerId);
}

const UTILITIES = SQUARES.map((q, i) => q.type === 'utility' ? i : -1).filter(i => i >= 0);

export function rentFor(s, idx, diceSum = 7, mult = 1) {
  const sq = SQUARES[idx], pr = s.props[idx];
  if (!pr || pr.mortgaged) return 0;
  let rent = 0;
  if (sq.type === 'country') {
    const base = baseRent(sq);
    if (pr.houses > 0) rent = base * HOUSE_MULT[pr.houses];
    else rent = ownsGroup(s, pr.owner, sq.group) ? base * 2 : base;
  } else if (sq.type === 'airport') {
    rent = AIRPORT_RENT[AIRPORTS.filter(i => s.props[i]?.owner === pr.owner).length];
  } else if (sq.type === 'utility') {
    const n = UTILITIES.filter(i => s.props[i]?.owner === pr.owner).length;
    rent = diceSum * UTILITY_MULT[n];
  }
  return rent * mult;
}

// 资产明细：现金、地（抵押的按一半）、房子（按买入价）
export function assets(s, p) {
  const a = { cash: p.cash, land: 0, houses: 0, count: 0 };
  for (const [i, pr] of Object.entries(s.props)) {
    if (pr.owner !== p.id) continue;
    const sq = SQUARES[i];
    a.count++;
    a.land += pr.mortgaged ? mortgageValue(sq) : sq.price;
    if (pr.houses) a.houses += pr.houses * GROUPS[sq.group].house;
  }
  return a;
}

export function netWorth(s, p) {
  const a = assets(s, p);
  return a.cash + a.land + a.houses;
}

// 停在自己的国家上才能盖，不用买齐整组；每次停留最多盖 BUILD_PER_STOP 栋
function canBuild(s, p, idx) {
  const sq = SQUARES[idx], pr = s.props[idx];
  if (!pr || pr.owner !== p.id || sq.type !== 'country') return '这不是你的国家';
  if (s.stop?.square !== idx || current(s).id !== p.id) return '只能在停留的国家上盖房';
  if (pr.mortgaged) return '抵押中不能盖房';
  if (pr.houses >= 5) return '已经是酒店了';
  if (s.stop.built >= BUILD_PER_STOP) return `每次停留最多盖 ${BUILD_PER_STOP} 栋`;
  if (p.cash < GROUPS[sq.group].house) return '钱不够';
  return null;
}

function canSell(s, p, idx) {
  const sq = SQUARES[idx], pr = s.props[idx];
  if (!pr || pr.owner !== p.id || !pr.houses) return '这里没有你的房子';
  return null;
}

function canMortgage(s, p, idx) {
  const sq = SQUARES[idx], pr = s.props[idx];
  if (!pr || pr.owner !== p.id) return '这不是你的';
  if (pr.mortgaged) return '已经抵押了';
  if (pr.houses) return '这里有房子，要先卖房';
  return null;
}

function canUnmortgage(s, p, idx) {
  const pr = s.props[idx];
  if (!pr || pr.owner !== p.id || !pr.mortgaged) return '这里没有抵押';
  if (p.cash < unmortgageCost(SQUARES[idx])) return '钱不够';
  return null;
}

// 卖给其他玩家：地连房子一起转手，抵押状态不变。成本 = 地价 + 房子买入价
export function saleCost(s, idx) {
  const sq = SQUARES[idx], pr = s.props[idx];
  return sq.price + (pr?.houses || 0) * (GROUPS[sq.group]?.house || 0);
}
const OFFER_PHASES = ['roll', 'manage', 'buy', 'debt'];

const MANAGE = {
  build: { phases: ['roll', 'manage', 'buy'], check: canBuild },
  sell: { phases: ['roll', 'manage', 'buy', 'debt'], check: canSell },
  mortgage: { phases: ['roll', 'manage', 'buy', 'debt'], check: canMortgage },
  unmortgage: { phases: ['roll', 'manage', 'buy'], check: canUnmortgage },
};

// 某玩家现在能做的所有动作（前端按钮和机器人测试都用它）
export function legalActions(s, pid) {
  if (s.status !== 'playing') return [];
  const p = player(s, pid);
  if (!p || p.bankrupt) return [];
  const out = [{ type: 'resign' }];
  if (s.offer && s.offer.from !== pid && p.cash >= s.offer.price) out.push({ type: 'acceptOffer' });
  if (current(s).id !== pid) return out;
  const ph = s.phase;
  if (s.offer?.from === pid) out.push({ type: 'cancelOffer' });
  else if (OFFER_PHASES.includes(ph)) {
    for (const [i, pr] of Object.entries(s.props)) {
      if (pr.owner === pid) out.push({ type: 'offer', square: +i, price: saleCost(s, +i) + 100 });
    }
  }
  if (ph === 'roll') {
    out.push({ type: 'roll' });
    if (p.inJail && p.cash >= JAIL_FINE) out.push({ type: 'payJail' });
    if (p.inJail && p.jailCards > 0) out.push({ type: 'useCard' });
  }
  if (ph === 'buy') {
    const sq = SQUARES[s.pending.square];
    for (let n = 0; n <= (sq.type === 'country' ? BUILD_PER_STOP : 0); n++) {
      if (p.cash >= sq.price + n * (GROUPS[sq.group]?.house || 0)) out.push(n ? { type: 'buy', build: n } : { type: 'buy' });
    }
    out.push({ type: 'skip' });
  }
  if (ph === 'manage') out.push({ type: 'end' });
  if (ph === 'debt') {
    if (p.cash >= totalOwed(p)) out.push({ type: 'payDebt' });
    out.push({ type: 'bankrupt' });
  }
  for (const [type, m] of Object.entries(MANAGE)) {
    if (!m.phases.includes(ph)) continue;
    for (const i of Object.keys(s.props)) {
      if (s.offer?.square === +i) continue;
      if (!m.check(s, p, +i)) out.push({ type, square: +i });
    }
  }
  return out;
}

// ---------- 动作 ----------

export function act(s, pid, action, ctx) {
  if (s.status !== 'playing') fail('对局已经结束');
  const p = player(s, pid);
  if (!p || p.bankrupt) fail('你已经出局了');
  if (action.type === 'buy' && action.build != null && !Number.isInteger(Number(action.build))) fail('盖房数量必须是整数');
  s.events = [];

  if (action.type === 'resign') {
    log(s, ctx, `${p.name} 认输`);
    goBankrupt(s, p, ctx, 'resign');
    return finishAct(s, ctx);
  }
  // 别人挂出来卖的地，不用等轮到自己就能买
  if (action.type === 'acceptOffer') {
    const o = s.offer;
    if (!o) fail('现在没有人在卖地');
    if (o.from === pid) fail('不能买自己的地');
    if (p.cash < o.price) fail('钱不够');
    const seller = player(s, o.from), sq = SQUARES[o.square], pr = s.props[o.square];
    if (!pr || pr.owner !== seller.id) { s.offer = null; fail('这块地已经不在他手里了'); }
    s.offer = null;
    ev(s, { k: 'trade', from: seller.id, to: p.id, square: o.square, price: o.price, houses: pr.houses, mortgaged: pr.mortgaged });
    pay(s, p, seller.id, o.price, ctx, `买下${sq.name}`);
    pr.owner = p.id;
    log(s, ctx, `${p.name} 花 $${o.price} 从 ${seller.name} 手里买下 ${sq.name}${pr.houses ? `（连 ${pr.houses === 5 ? '酒店' : `${pr.houses} 栋房`}）` : ''}${pr.mortgaged ? '（抵押中）' : ''}`);
    return finishAct(s, ctx);
  }
  if (current(s).id !== pid) fail('还没轮到你');

  const t = action.type;
  if (MANAGE[t]) {
    if (!MANAGE[t].phases.includes(s.phase)) fail('现在不能这样做');
    const idx = Number(action.square);
    if (s.offer?.square === idx) fail('这块地正在出售，先取消出售');
    const err = MANAGE[t].check(s, p, idx);
    if (err) fail(err);
    doManage(s, p, t, idx, ctx);
    return finishAct(s, ctx);
  }

  switch (t) {
    case 'offer': {
      if (!OFFER_PHASES.includes(s.phase)) fail('现在不能卖地');
      if (s.offer) fail('已经有一块地在出售');
      const idx = Number(action.square), price = Math.round(Number(action.price));
      if (s.props[idx]?.owner !== p.id) fail('这不是你的');
      if (!(price >= 1 && price <= 100000)) fail('价格不对');
      s.offer = { square: idx, price, from: p.id };
      ev(s, { k: 'offer', pid: p.id, square: idx, price });
      log(s, ctx, `${p.name} 出售 ${SQUARES[idx].name}，要价 $${price}`);
      break;
    }
    case 'cancelOffer': {
      if (s.offer?.from !== p.id) fail('你没有在卖地');
      log(s, ctx, `没人买，${p.name} 收回 ${SQUARES[s.offer.square].name}`);
      s.offer = null;
      break;
    }
    case 'roll': {
      if (s.phase !== 'roll') fail('现在不能掷骰');
      doRoll(s, p, ctx);
      settle(s, p);
      break;
    }
    case 'payJail': {
      if (s.phase !== 'roll' || !p.inJail) fail('你不在监狱');
      if (p.cash < JAIL_FINE) fail('钱不够');
      bank(s, p, -JAIL_FINE, '出狱罚金');
      p.inJail = false; p.jailTurns = 0;
      ev(s, { k: 'free', pid: p.id });
      log(s, ctx, `${p.name} 交了 $${JAIL_FINE} 出狱`);
      break;
    }
    case 'useCard': {
      if (s.phase !== 'roll' || !p.inJail || !p.jailCards) fail('不能用出狱卡');
      p.jailCards--; s.discard.push(6);
      p.inJail = false; p.jailTurns = 0;
      ev(s, { k: 'free', pid: p.id });
      log(s, ctx, `${p.name} 用出狱卡出狱`);
      break;
    }
    case 'buy': {
      if (s.phase !== 'buy') fail('现在不能买');
      const sq = SQUARES[s.pending.square];
      const build = sq.type === 'country' ? Math.max(0, Math.min(BUILD_PER_STOP, Number(action.build) || 0)) : 0;
      if (p.cash < sq.price + build * (GROUPS[sq.group]?.house || 0)) fail('钱不够');
      bank(s, p, -sq.price, `买下${sq.name}`);
      s.props[sq.index] = { owner: p.id, houses: 0, mortgaged: false };
      ev(s, { k: 'buy', pid: p.id, square: sq.index });
      log(s, ctx, `${p.name} 买下 ${sq.name}（$${sq.price}）`);
      s.pending = null;
      for (let k = 0; k < build; k++) doManage(s, p, 'build', sq.index, ctx);
      settle(s, p);
      break;
    }
    case 'skip': {
      if (s.phase !== 'buy') fail('现在不能这样做');
      log(s, ctx, `${p.name} 没有买 ${SQUARES[s.pending.square].name}`);
      s.pending = null;
      settle(s, p);
      break;
    }
    case 'payDebt': {
      if (s.phase !== 'debt') fail('你没有欠债');
      if (p.cash < totalOwed(p)) fail('钱还不够，先卖房或抵押');
      payOwed(s, p, ctx);
      s.phase = s.afterDebt; s.afterDebt = null;
      break;
    }
    case 'bankrupt': {
      if (s.phase !== 'debt') fail('你没有欠债');
      log(s, ctx, `${p.name} 宣告破产`);
      goBankrupt(s, p, ctx);
      break;
    }
    case 'end': {
      if (s.phase !== 'manage') fail('现在不能结束回合');
      nextTurn(s, ctx);
      break;
    }
    default: fail('未知动作');
  }
  return finishAct(s, ctx);
}

// 超时或掉线：替当前玩家做最保守的动作
export function autoAct(s, ctx) {
  if (s.status !== 'playing') return s;
  const p = current(s);
  switch (s.phase) {
    case 'roll': return act(s, p.id, { type: 'roll' }, ctx);
    case 'buy': return act(s, p.id, { type: 'skip' }, ctx);
    case 'manage': return act(s, p.id, { type: 'end' }, ctx);
    case 'debt':
      autoLiquidate(s, p, ctx);
      return act(s, p.id, { type: p.cash >= totalOwed(p) ? 'payDebt' : 'bankrupt' }, ctx);
  }
  return s;
}

function finishAct(s, ctx) {
  s.seq++;
  s.deadline = ctx.now + TURN_SECONDS * 1000;
  return s;
}

// ---------- 内部 ----------

function ev(s, e) { s.events.push(e); }

function log(s, ctx, msg) {
  s.log.push({ t: ctx.now, msg });
  if (s.log.length > MAX_LOG) s.log.shift();
}

// 银行和玩家之间的钱：正数是银行发给玩家，负数是玩家交给银行
function bank(s, p, amount, why) {
  if (!amount) return;
  p.cash += amount;
  s.bankNet += amount;
  if (amount > 0) s.bankOut += amount; else s.bankIn -= amount;
  ev(s, amount > 0
    ? { k: 'money', from: null, to: p.id, amount, why }
    : { k: 'money', from: p.id, to: null, amount: -amount, why });
}

// 付钱：to = 玩家 id 或 null（银行）。钱不够的部分记为欠款
function pay(s, from, to, amount, ctx, why) {
  if (amount <= 0) return;
  const covered = Math.min(from.cash, amount);
  from.cash -= covered;
  if (to) player(s, to).cash += covered;
  else { s.bankNet -= covered; s.bankIn += covered; }
  if (covered) ev(s, { k: 'money', from: from.id, to, amount: covered, why });
  if (covered < amount) from.owed.push({ to, amount: amount - covered });
  const toName = to ? player(s, to).name : '银行';
  log(s, ctx, `${from.name} 付给${toName} $${amount}${why ? `（${why}）` : ''}${covered < amount ? `，还欠 $${amount - covered}` : ''}`);
}

function payOwed(s, p, ctx) {
  for (const o of p.owed) {
    // 旧存档的欠款可能仍指向已经出局的玩家，交由银行清算。
    const target = o.to && player(s, o.to);
    const creditor = target && !target.bankrupt ? target : null;
    p.cash -= o.amount;
    if (creditor) creditor.cash += o.amount;
    else { s.bankNet -= o.amount; s.bankIn += o.amount; }
    ev(s, { k: 'money', from: p.id, to: creditor?.id ?? null, amount: o.amount, why: '还清欠款' });
  }
  log(s, ctx, `${p.name} 还清了欠款 $${totalOwed(p)}`);
  p.owed = [];
}

function doManage(s, p, t, idx, ctx) {
  const sq = SQUARES[idx], pr = s.props[idx];
  const houseCost = sq.group ? GROUPS[sq.group].house : 0;
  if (t === 'build') {
    bank(s, p, -houseCost, `${sq.name}盖房`);
    pr.houses++;
    if (s.stop?.square === idx) s.stop.built++;
    log(s, ctx, `${p.name} 在 ${sq.name} 盖了${pr.houses === 5 ? '酒店' : `第 ${pr.houses} 栋房`}`);
  } else if (t === 'sell') {
    bank(s, p, Math.floor(houseCost / 2), `${sq.name}卖房`);
    pr.houses--;
    log(s, ctx, `${p.name} 卖掉 ${sq.name} 的一栋房，得 $${Math.floor(houseCost / 2)}`);
  } else if (t === 'mortgage') {
    bank(s, p, mortgageValue(sq), `${sq.name}抵押贷款`);
    pr.mortgaged = true;
    log(s, ctx, `${p.name} 抵押 ${sq.name}，得 $${mortgageValue(sq)}`);
  } else if (t === 'unmortgage') {
    bank(s, p, -unmortgageCost(sq), `${sq.name}还贷`);
    pr.mortgaged = false;
    log(s, ctx, `${p.name} 赎回 ${sq.name}，付 $${unmortgageCost(sq)}`);
  }
  ev(s, { k: 'prop', type: t, square: idx, pid: p.id });
}

function doRoll(s, p, ctx) {
  const d = [1 + Math.floor(ctx.rng() * 6), 1 + Math.floor(ctx.rng() * 6)];
  const sum = d[0] + d[1], dbl = d[0] === d[1];
  s.dice = d;
  s.card = null;
  ev(s, { k: 'dice', d, pid: p.id });
  log(s, ctx, `${p.name} 掷出 ${d[0]} + ${d[1]}${dbl ? '（双数）' : ''}`);

  if (p.inJail) {
    s.rollAgain = false;
    if (dbl) {
      p.inJail = false; p.jailTurns = 0;
      log(s, ctx, `${p.name} 掷出双数，出狱`);
      return move(s, p, sum, ctx);
    }
    p.jailTurns++;
    if (p.jailTurns < 3) return log(s, ctx, `${p.name} 继续坐牢（第 ${p.jailTurns} 回合）`);
    ev(s, { k: 'charge', kind: 'jailfine', pid: p.id, to: null, square: JAIL_POS, amount: JAIL_FINE });
    pay(s, p, null, JAIL_FINE, ctx, '第 3 回合出狱罚金');
    p.inJail = false; p.jailTurns = 0;
    return move(s, p, sum, ctx);
  }

  if (dbl) {
    s.doubles++;
    if (s.doubles >= 3) {
      log(s, ctx, `${p.name} 连续 3 次双数`);
      return sendJail(s, p, ctx, 'doubles');
    }
    s.rollAgain = true;
  } else {
    s.rollAgain = false;
  }
  move(s, p, sum, ctx);
}

function move(s, p, steps, ctx) {
  const to = (p.pos + steps) % BOARD_SIZE;
  ev(s, { k: 'move', pid: p.id, from: p.pos, to, steps, dir: 1 });
  if (p.pos + steps >= BOARD_SIZE) {
    bank(s, p, GO_SALARY, '经过起点工资');
    log(s, ctx, `${p.name} 经过起点，领 $${GO_SALARY}`);
  }
  p.pos = to;
  land(s, p, ctx, 1);
}

function moveTo(s, p, to, ctx, mult = 1) {
  ev(s, { k: 'move', pid: p.id, from: p.pos, to, steps: (to - p.pos + BOARD_SIZE) % BOARD_SIZE || BOARD_SIZE, dir: 1 });
  if (to <= p.pos) {
    bank(s, p, GO_SALARY, '经过起点工资');
    log(s, ctx, `${p.name} 经过起点，领 $${GO_SALARY}`);
  }
  p.pos = to;
  land(s, p, ctx, mult);
}

function sendJail(s, p, ctx, reason = 'card') {
  ev(s, { k: 'jail', pid: p.id, from: p.pos, reason });
  s.stop = null;
  p.pos = JAIL_POS; p.inJail = true; p.jailTurns = 0;
  s.rollAgain = false; s.doubles = 0;
  log(s, ctx, `${p.name} 进了监狱`);
}

function land(s, p, ctx, mult) {
  const sq = SQUARES[p.pos];
  s.stop = { square: sq.index, built: 0 };
  if (sq.price) {
    const pr = s.props[sq.index];
    if (!pr) { s.pending = { square: sq.index }; return; }
    if (pr.owner === p.id) return;
    if (pr.mortgaged) {
      ev(s, { k: 'charge', kind: 'mortgaged', pid: p.id, to: pr.owner, square: sq.index, amount: 0 });
      return log(s, ctx, `${sq.name} 已抵押，不收过路费`);
    }
    const sum = s.dice ? s.dice[0] + s.dice[1] : 7;
    const rent = rentFor(s, sq.index, sum, mult);
    ev(s, { k: 'charge', kind: 'rent', pid: p.id, to: pr.owner, square: sq.index, amount: rent, houses: pr.houses, mult });
    pay(s, p, pr.owner, rent, ctx, `${sq.name} 过路费`);
    return;
  }
  if (sq.type === 'tax') {
    ev(s, { k: 'charge', kind: 'tax', pid: p.id, to: null, square: sq.index, amount: sq.amount });
    return pay(s, p, null, sq.amount, ctx, sq.name);
  }
  if (sq.type === 'gotojail') return sendJail(s, p, ctx, 'square');
  if (sq.type === 'chance' || sq.type === 'fate') return drawCard(s, p, ctx);
}

function drawCard(s, p, ctx) {
  if (!s.deck.length) { s.deck = shuffle(s.discard, ctx.rng); s.discard = []; }
  const id = s.deck.shift();
  const card = CARDS.find(c => c.id === id);
  s.card = { id, text: card.text, by: p.id, deck: SQUARES[p.pos].type };
  ev(s, { k: 'card', pid: p.id, deck: SQUARES[p.pos].type, text: card.text, mood: card.mood, id });
  log(s, ctx, `${p.name} 抽到「${card.text}」`);
  if (card.kind !== 'jailcard') s.discard.push(id);

  const others = alive(s).filter(o => o.id !== p.id);
  switch (card.kind) {
    case 'goto': return moveTo(s, p, card.to, ctx);
    case 'airport': return moveTo(s, p, AIRPORTS.find(a => a > p.pos) ?? AIRPORTS[0], ctx, 2);
    case 'back': {
      const to = (p.pos - card.n + BOARD_SIZE) % BOARD_SIZE;
      ev(s, { k: 'move', pid: p.id, from: p.pos, to, steps: card.n, dir: -1 });
      p.pos = to;
      return land(s, p, ctx, 1);
    }
    case 'jail': return sendJail(s, p, ctx);
    case 'jailcard': p.jailCards++; return;
    case 'money':
      if (card.amount > 0) return bank(s, p, card.amount, card.text);
      return pay(s, p, null, -card.amount, ctx, '罚款');
    case 'repairs': {
      let cost = 0;
      for (const pr of Object.values(s.props)) {
        if (pr.owner !== p.id) continue;
        cost += pr.houses === 5 ? card.hotel : pr.houses * card.house;
      }
      return pay(s, p, null, cost, ctx, '房屋维修');
    }
    case 'collectEach':
      for (const o of others) {
        pay(s, o, p.id, card.amount, ctx, '生日礼金');
        // 不在自己回合的人欠钱：系统自动卖房抵押，还不上就破产
        if (o.owed.length) {
          autoLiquidate(s, o, ctx);
          if (o.cash >= totalOwed(o)) payOwed(s, o, ctx);
          else goBankrupt(s, o, ctx);
        }
      }
      return;
    case 'payEach':
      for (const o of others) pay(s, p, o.id, card.amount, ctx, '主席');
      return;
  }
}

// 掷骰/买地之后决定下一个阶段
function settle(s, p) {
  if (s.status !== 'playing' || p.bankrupt) return;
  let next = s.pending ? 'buy' : (s.rollAgain && !p.inJail ? 'roll' : 'manage');
  if (p.owed.length) { s.afterDebt = next; next = 'debt'; }
  s.phase = next;
}

function autoLiquidate(s, p, ctx) {
  const mine = () => Object.keys(s.props).map(Number).filter(i => s.props[i].owner === p.id);
  while (p.cash < totalOwed(p)) {
    const sellable = mine().filter(i => !canSell(s, p, i))
      .sort((a, b) => GROUPS[SQUARES[a].group].house - GROUPS[SQUARES[b].group].house);
    if (sellable.length) { doManage(s, p, 'sell', sellable[0], ctx); continue; }
    const mortgageable = mine().filter(i => !canMortgage(s, p, i))
      .sort((a, b) => SQUARES[a].price - SQUARES[b].price);
    if (mortgageable.length) { doManage(s, p, 'mortgage', mortgageable[0], ctx); continue; }
    break;
  }
}

function goBankrupt(s, p, ctx, reason = 'debt') {
  const wasCurrent = current(s).id === p.id;
  if (s.offer?.from === p.id) s.offer = null;
  const creditors = [...new Set(p.owed.map(o => o.to))];
  const beneficiary = reason === 'debt' && creditors.length === 1 && creditors[0] ? player(s, creditors[0]) : null;
  const creditor = beneficiary && !beneficiary.bankrupt ? beneficiary : null;

  // 先把破产清单告诉界面：欠多少、哪些国家（含抵押状态、要拆的房子）、多少现金归谁
  const props = Object.entries(s.props).filter(([, pr]) => pr.owner === p.id)
    .map(([i, pr]) => ({ square: +i, mortgaged: pr.mortgaged, houses: pr.houses }));
  const houseCash = props.reduce((a, x) => a + x.houses * Math.floor(GROUPS[SQUARES[x.square].group]?.house / 2 || 0), 0);
  ev(s, { k: 'bankruptcy', pid: p.id, to: creditor ? creditor.id : null, owed: totalOwed(p), cash: p.cash + houseCash, houseCash, props });

  // 房子先按半价卖回银行
  for (const [i, pr] of Object.entries(s.props)) {
    if (pr.owner === p.id && pr.houses) {
      bank(s, p, pr.houses * Math.floor(GROUPS[SQUARES[i].group].house / 2), '破产卖房');
      pr.houses = 0;
    }
  }
  if (creditor) {
    if (p.cash) ev(s, { k: 'money', from: p.id, to: creditor.id, amount: p.cash, why: '破产清算' });
    creditor.cash += p.cash;
    creditor.jailCards += p.jailCards;
    for (const pr of Object.values(s.props)) if (pr.owner === p.id) pr.owner = creditor.id;
    log(s, ctx, `${p.name} 的现金和国家全部归 ${creditor.name}`);
  } else {
    s.bankNet -= p.cash; s.bankIn += p.cash;
    if (p.cash) ev(s, { k: 'money', from: p.id, to: null, amount: p.cash, why: '破产清算' });
    for (let k = 0; k < p.jailCards; k++) s.discard.push(6);
    for (const [i, pr] of Object.entries(s.props)) if (pr.owner === p.id) delete s.props[i];
    log(s, ctx, `${p.name} 的国家全部收回银行`);
  }
  p.cash = 0; p.jailCards = 0; p.owed = []; p.bankrupt = true; p.inJail = false;
  for (const debtor of s.players) {
    for (const debt of debtor.owed) if (debt.to === p.id) debt.to = null;
  }
  ev(s, { k: 'bankrupt', pid: p.id });

  const left = alive(s);
  if (left.length === 1) return endGame(s, left[0], 'last', ctx);
  if (wasCurrent) {
    s.pending = null;
    nextTurn(s, ctx);
  }
}

// 轮到下一位；时间到了就等这一轮走完再结算
function nextTurn(s, ctx) {
  let idx = s.turnIdx;
  do { idx = (idx + 1) % s.order.length; } while (s.players[s.order[idx]].bankrupt);
  if (idx <= s.turnIdx) {
    if (s.endsAt && ctx.now >= s.endsAt) return endByTime(s, ctx);
    s.round++;
  }
  s.turnIdx = idx;
  s.rollAgain = false; s.doubles = 0; s.pending = null; s.afterDebt = null; s.stop = null; s.offer = null;
  s.phase = 'roll';
  ev(s, { k: 'turn', pid: current(s).id });
}

function endByTime(s, ctx, reason = 'time') {
  const ranked = alive(s).slice().sort((a, b) => netWorth(s, b) - netWorth(s, a));
  log(s, ctx, reason === 'host' ? '主持人结束对局，按净资产结算' : '时间到，按净资产结算');
  endGame(s, ranked[0], reason, ctx);
}

// 主持人提前结束：马上按净资产结算
export function finishNow(s, ctx) {
  if (s.status !== 'playing') fail('对局已经结束');
  s.events = [];
  endByTime(s, ctx, 'host');
  return finishAct(s, ctx);
}

function endGame(s, winner, reason, ctx) {
  s.status = 'ended';
  s.phase = 'ended';
  s.winner = winner.id;
  s.endReason = reason;
  s.ranking = s.players.slice()
    .sort((a, b) => (a.bankrupt - b.bankrupt) || netWorth(s, b) - netWorth(s, a))
    .map(p => ({ id: p.id, name: p.name, worth: netWorth(s, p), bankrupt: p.bankrupt, ...assets(s, p) }));
  log(s, ctx, `${winner.name} 获胜！`);
  ev(s, { k: 'end', winner: winner.id });
}

// 发给前端前去掉牌堆顺序
export function publicView(s) {
  const { deck, discard, ...rest } = s;
  return { ...rest, deckLeft: deck.length };
}
