// 机器人随机打很多局：不报错、每局都能结束、钱对得上账、状态始终合法。
// 用法：node test/sim.mjs [局数]

import { createGame, act, autoAct, legalActions, current, alive, RuleError } from '../shared/engine.js';
import { SQUARES, BUILD_PER_STOP } from '../shared/board.js';

const GAMES = Number(process.argv[2] || 300);

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function check(s, where) {
  const sum = s.players.reduce((a, p) => a + p.cash, 0);
  const expect = s.startCash * s.players.length + s.bankNet;
  if (sum !== expect) throw new Error(`${where}: 账不平 ${sum} != ${expect}`);
  if (s.bankOut - s.bankIn !== s.bankNet) throw new Error(`${where}: 银行流水对不上`);
  for (const p of s.players) {
    if (p.cash < 0) throw new Error(`${where}: ${p.name} 现金为负`);
    if (p.bankrupt && (p.cash || p.owed.length)) throw new Error(`${where}: 破产者还有钱`);
    if (!p.bankrupt && p.owed.length && !(s.phase === 'debt' && current(s).id === p.id)) {
      throw new Error(`${where}: ${p.name} 欠债却不在还债阶段`);
    }
  }
  for (const [i, pr] of Object.entries(s.props)) {
    const owner = s.players.find(p => p.id === pr.owner);
    if (!owner || owner.bankrupt) throw new Error(`${where}: 格 ${i} 主人无效`);
    if (pr.houses < 0 || pr.houses > 5) throw new Error(`${where}: 房子数错误`);
    if (pr.houses && pr.mortgaged) throw new Error(`${where}: 抵押的格子有房`);
    if (pr.houses && SQUARES[i].type !== 'country') throw new Error(`${where}: 机场或公司上有房`);
  }
  if (s.stop && s.stop.built > BUILD_PER_STOP) throw new Error(`${where}: 一次停留盖了 ${s.stop.built} 栋`);
  if (s.status === 'playing' && current(s).bankrupt) throw new Error(`${where}: 轮到破产玩家`);
}

const stats = { last: 0, time: 0, actions: 0, bankrupt: 0, hotels: 0, debts: 0 };

for (let g = 0; g < GAMES; g++) {
  const rng = mulberry(g + 1);
  const ctx = { now: 0, rng };
  const n = 2 + (g % 5);
  const players = Array.from({ length: n }, (_, i) => ({ id: `u${i}`, name: `机器人${i + 1}` }));
  if (g % 2) players[0].avatar = '1f436';   // 一半的局里 1 号选小狗，开局多 $500
  const s = createGame(players, { durationMin: g % 3 === 0 ? 0 : 60 }, ctx);
  if (s.players[0].cash !== s.startCash + (g % 2 ? 500 : 0)) throw new Error(`第 ${g} 局小狗奖励不对`);
  let steps = 0;

  while (s.status === 'playing') {
    if (++steps > 200000) throw new Error(`第 ${g} 局没有结束`);
    ctx.now += 2000;
    const where = `第 ${g} 局第 ${steps} 步`;
    // 不限时的局最多打 6 小时，然后改成限时让它收尾
    if (!s.endsAt && ctx.now > 6 * 3600e3) s.endsAt = ctx.now;

    if (rng() < 0.05) {
      autoAct(s, ctx);
    } else {
      const p = current(s);
      let acts = legalActions(s, p.id).filter(a => a.type !== 'resign');
      if (rng() < 0.0005) acts = [{ type: 'resign' }];
      // 偏向买地、盖房，让对局更快结束
      const prefer = acts.filter(a => ['buy', 'build', 'payDebt', 'unmortgage'].includes(a.type));
      const pick = (prefer.length && rng() < 0.7 ? prefer : acts)[Math.floor(rng() * (prefer.length && rng() < 0.7 ? prefer.length : acts.length))]
        ?? acts[0];
      if (s.phase === 'debt') stats.debts++;
      try {
        act(s, p.id, pick, ctx);
      } catch (e) {
        if (e instanceof RuleError) throw new Error(`${where}: 合法动作被拒 ${JSON.stringify(pick)}：${e.message}`);
        throw e;
      }
      // 有人挂地出售：随机一位买得起的玩家一半概率买下
      if (s.offer && s.status === 'playing' && rng() < 0.5) {
        const buyers = s.players.filter(o => legalActions(s, o.id).some(x => x.type === 'acceptOffer'));
        if (buyers.length) {
          const b = buyers[Math.floor(rng() * buyers.length)];
          const sq = s.offer.square;
          act(s, b.id, { type: 'acceptOffer' }, ctx);
          if (s.props[sq].owner !== b.id) throw new Error(`${where}: 买地后主人不对`);
          stats.trades = (stats.trades || 0) + 1;
        }
      }
      // 随机挑一个非法动作，必须被拒绝
      if (rng() < 0.02 && s.status === 'playing') {
        const other = s.players.find(o => o.id !== current(s).id && !o.bankrupt);
        if (other) {
          try { act(s, other.id, { type: 'roll' }, ctx); throw new Error(`${where}: 非法动作被接受`); }
          catch (e) { if (!(e instanceof RuleError)) throw e; }
        }
      }
    }
    for (const pr of Object.values(s.props)) if (pr.houses === 5) stats.hotels++;
    check(s, where);
  }
  stats[s.endReason]++;
  stats.actions += steps;
  stats.bankrupt += s.players.filter(p => p.bankrupt).length;
  if (!s.winner || alive(s).every(p => p.id !== s.winner)) throw new Error(`第 ${g} 局赢家无效`);
}

console.log(`通过：${GAMES} 局全部结束`);
console.log(`  打到只剩一人 ${stats.last} 局，时间到结算 ${stats.time} 局`);
console.log(`  平均每局 ${Math.round(stats.actions / GAMES)} 步，共 ${stats.bankrupt} 人破产，进入还债阶段 ${stats.debts} 次，出现过酒店 ${stats.hotels > 0 ? '是' : '否'}，玩家之间买卖地 ${stats.trades || 0} 次`);
