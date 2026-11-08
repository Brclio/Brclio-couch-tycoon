// Exact rule boundaries that random bot strategies may never visit.
import assert from 'node:assert/strict';
import { act, createGame, RuleError } from '../shared/engine.js';
import { mortgageValue, OWNABLE, SQUARES, unmortgageCost } from '../shared/board.js';

const ctx = { now: 123, rng: () => 0.25 };
const newGame = () => createGame(['A', 'B', 'C'].map(id => ({ id, name: id })), { shuffleOrder: false }, ctx);

for (const i of OWNABLE) {
  const sq = SQUARES[i];
  const principal = mortgageValue(sq);
  assert.equal(unmortgageCost(sq), principal + Math.ceil(principal / 10));
}
assert.equal(unmortgageCost(SQUARES[9]), 110);

{
  const g = newGame();
  g.phase = 'buy';
  g.pending = { square: 1 };
  g.stop = { square: 1, built: 0 };
  g.players[0].cash = 85;
  const before = structuredClone(g);
  for (const build of [0.5, '0.5', NaN, Infinity]) {
    assert.throws(() => act(g, 'A', { type: 'buy', build }, ctx), RuleError);
    assert.deepEqual(g, before);
  }
  assert.throws(() => act(g, 'A', { type: 'buy', build: 1 }, ctx), RuleError);
  act(g, 'A', { type: 'buy' }, ctx);
  assert.equal(g.players[0].cash, 25);
  assert.equal(g.props[1].houses, 0);
}

function inDebt() {
  const g = newGame();
  g.phase = 'debt';
  g.afterDebt = 'manage';
  g.players[0].cash = 0;
  g.players[0].owed = [{ to: 'B', amount: 20 }];
  g.props[1] = { owner: 'A', houses: 0, mortgaged: false };
  return g;
}

{
  const g = inDebt();
  const cash = g.players[1].cash;
  act(g, 'A', { type: 'resign' }, ctx);
  assert.equal(g.props[1], undefined);
  assert.equal(g.players[1].cash, cash);
}
{
  const g = inDebt();
  act(g, 'A', { type: 'bankrupt' }, ctx);
  assert.equal(g.props[1].owner, 'B');
}
for (const legacyCreditor of [false, true]) {
  const g = inDebt();
  act(g, 'B', { type: 'resign' }, ctx);
  assert.equal(g.players[0].owed[0].to, null);
  if (legacyCreditor) g.players[0].owed[0].to = 'B';
  const restored = JSON.parse(JSON.stringify(g));
  act(restored, 'A', { type: 'mortgage', square: 1 }, ctx);
  const previousBankIn = restored.bankIn;
  act(restored, 'A', { type: 'payDebt' }, ctx);
  assert.equal(restored.players[1].cash, 0);
  assert.equal(restored.players[0].cash, 10);
  assert.equal(restored.bankIn - previousBankIn, 20);
  assert.equal(restored.events.find(e => e.k === 'money').to, null);
}
{
  const g = inDebt();
  act(g, 'B', { type: 'resign' }, ctx);
  g.players[0].owed[0].to = 'B';
  act(g, 'A', { type: 'bankrupt' }, ctx);
  assert.equal(g.props[1], undefined);
  assert.equal(g.winner, 'C');
}
{
  const g = newGame();
  g.phase = 'manage';
  g.stop = { square: 1, built: 0 };
  g.props[1] = { owner: 'A', houses: 4, mortgaged: false };
  const restored = JSON.parse(JSON.stringify(g));
  for (const state of [g, restored]) act(state, 'A', { type: 'build', square: 1 }, ctx);
  assert.deepEqual(restored, g);
  assert.equal(g.props[1].houses, 5);
  assert.throws(() => act(g, 'A', { type: 'build', square: 1 }, ctx), RuleError);
}
console.log('通过：54 种赎回价、小数建房、认输与破产的资产归属、旧债权人、存档恢复与酒店');
