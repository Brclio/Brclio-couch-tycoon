// Browser regression. Start the Worker first. Usage: node test/web.mjs [https://…]
// Set BROWSER_EXECUTABLE for another Chromium binary, or install Google Chrome.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const base = new URL(process.argv[2] || 'http://localhost:5200').origin;
const browser = await chromium.launch({
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [];

async function player(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  const client = { page, room: null, id: null };
  page.on('websocket', ws => ws.on('framereceived', frame => {
    const msg = JSON.parse(frame.payload);
    if (msg.t === 'room') { client.room = msg.room; client.id = msg.me; }
  }));
  return client;
}

async function until(check, description, timeout = 45000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < end);
  throw Error('等待超时：' + description);
}

// Count the dots on the face actually pointing at the camera. This checks the
// rendered CSS transforms independently of the game's face-to-angle mapping.
async function expectDice(page, values, animated = false) {
  const expected = values ?? [6, 6];
  await until(async () => {
    const dice = await page.locator('#dice .cube').evaluateAll(cubes => cubes.map(cube => {
      const turn = new DOMMatrixReadOnly(getComputedStyle(cube).transform);
      for (const face of cube.querySelectorAll('.face')) {
        const side = new DOMMatrixReadOnly(getComputedStyle(face).transform);
        if (turn.multiply(side).m33 > 0.9999) {
          return {value: face.querySelectorAll('i.on').length, animated: !cube.classList.contains('no-anim')};
        }
      }
      return null;
    }));
    return dice.length === 2 && dice.every((d, i) => d?.value === expected[i] && d.animated === animated);
  }, '骰面显示 ' + expected.join('、'), 5000);
}

async function roomFlow() {
  const host = await player(1440, 900);
  let guest = await player(375, 812);
  const players = [host, guest];
  await host.page.goto(base);
  await host.page.locator('.mini-board i').last().waitFor();
  assert.equal(await host.page.locator('.mini-board i').count(), 68);
  await host.page.locator('#create').click();
  await host.page.waitForURL('**/p/*');
  await host.page.locator('[data-invite]').click();
  const invite = await host.page.locator('#inviteUrl').getAttribute('href');
  assert.equal(invite, host.page.url());
  await host.page.locator('.close-dialog').click();
  await guest.page.goto(invite);
  for (const [client, avatar] of [[host,'1f43c'], [guest,'1f436']]) {
    await client.page.locator('[data-char="'+avatar+'"]').click();
    await client.page.locator('[data-ready="1"]').click();
  }
  assert.equal(await guest.page.locator('[data-host]').count(), 0);
  await host.page.locator('[data-host="start"]').click();
  await until(() => host.room?.status === 'playing', '开局');
  const turn = () => {
    const g = host.room.game;
    return players.find(p => p.id === g.players[g.order[g.turnIdx]].id);
  };
  async function settled() {
    await until(async () => {
      const room = host.room, prompt = room.waitingFor;
      if (prompt) {
        const owner = players.find(p => p.id === prompt.pid);
        // The board overlay and the wallet both expose the seat's own confirmation.
        const action = owner.page.locator('#pok:visible:enabled, #cardOk:visible:enabled, [data-ack]:visible:enabled');
        if (await action.count()) await action.first().click({ timeout: 600 }).catch(() => {});
      }
      return !room.showing && !prompt;
    }, '棋盘动画与玩家确认');
  }
  async function action(client, selector) {
    const seq = host.room.game.seq;
    await client.page.locator(selector).first().click();
    await until(() => host.room.game.seq > seq, selector);
    await settled();
  }
  await settled();
  for (const p of players) assert.equal(await p.page.locator('#board .cell').count(), 68);
  assert.equal(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('✓ 同一网页呈现 68 格棋盘与个人操作，375px 手机无横向溢出');

  // Roll through real turns until a player can buy, list, and sell a property.
  let sold = false;
  for (let step = 0; step < 35 && !sold; step++) {
    await settled();
    const g = host.room.game, actor = turn();
    if (g.phase === 'roll') await action(actor, '#app [data-act=roll]:enabled');
    else if (g.phase === 'buy') {
      const square = g.pending.square;
      const build = actor.page.locator('#app [data-act=buy][data-build="1"]:enabled');
      if (!await build.count()) { await action(actor, '#app [data-act=skip]'); continue; }
      await action(actor, '#app [data-act=buy][data-build="1"]');
      await actor.page.locator('[data-sell="'+square+'"]').click();
      await actor.page.locator('#salePrice').fill('100');
      await action(actor,'[data-sell-ok]');
      const buyer = players.find(p => p !== actor);
      const cash = host.room.game.players.find(p => p.id === buyer.id).cash;
      await action(buyer,'[data-buy-offer]:enabled');
      assert.equal(host.room.game.props[square].owner, buyer.id);
      assert.equal(host.room.game.props[square].houses, 1);
      assert.equal(host.room.game.players.find(p => p.id === buyer.id).cash, cash - 100);
      sold = true;
    } else if (g.phase === 'manage') {
      const seq = g.seq;
      await until(() => host.room.game.seq > seq || actor.page.locator('#app [data-act=end]:enabled').count(), '结束回合');
      if (host.room.game.seq === seq) await action(actor,'#app [data-act=end]:enabled');
    } else throw Error('开局购地前进入异常阶段：' + g.phase);
  }
  assert.ok(sold, '买地加盖、挂牌、跨回合抢购');
  console.log('✓ 买地加盖、挂牌和抢购均通过玩家界面，买家现金、地产、房屋对账正确');

  await host.page.locator('[data-host=pause]').click();
  await host.page.locator('[data-host=resume]').waitFor();
  await host.page.locator('[data-host=resume]').click();
  const seat = guest.id;
  await guest.page.reload();
  await guest.page.locator('.wallet').waitFor();
  assert.equal(guest.id, seat);
  assert.equal(guest.room.seats.length, 2);
  await expectDice(guest.page, guest.room.game.dice);
  await guest.page.close();
  await until(() => host.room.seats.find(s => s.id === seat)?.online === false, '离线座位');
  await host.page.locator(`[data-do=rejoin][data-pid="${seat}"]`).click();
  await host.page.locator('#inviteDialog[open]').waitFor();
  const recovery = await host.page.locator('#inviteUrl').getAttribute('href');
  assert.ok(new URL(recovery).searchParams.has('claim'));
  await host.page.locator('.close-dialog').click();
  guest = await player(375, 812);
  players[1] = guest;
  await guest.page.goto(recovery);
  await guest.page.locator('.wallet').waitFor();
  assert.equal(guest.id, seat);
  assert.equal(new URL(guest.page.url()).search, '', '消费后清理认领链接');
  console.log('✓ 房主暂停、继续，手机刷新与跨浏览器私密认领都回到原座位');

  // A resignation always generates a bankruptcy prompt, regardless of dice.
  await settled();
  await guest.page.locator('[data-act=resign]:enabled').click();
  await until(() => host.room.waitingFor?.pid === guest.id, '破产确认');
  const started = Date.now();
  await until(() => !host.room.waitingFor, '服务器默认确认超时', 40000);
  assert.ok(Date.now() - started > 14000, '确认未被提前清掉');
  for (const p of players) {
    await p.page.locator('#again').waitFor();
    assert.equal(await p.page.locator('#rank li, .modal .rank li').count(), 2);
    assert.equal(await p.page.locator('#prompt.show, #cardLayer.show').count(), 0);
  }
  console.log('✓ 默认确认超时后两台浏览器都收起弹框、显示结算');
  await host.page.locator('#again').click();
  await guest.page.locator('[data-ready="1"]').waitFor();
  assert.equal(guest.room.seats.length, 2);

  for (const p of players) await p.page.locator('[data-ready="1"]').click();
  await host.page.locator('[data-host=start]').click();
  await until(() => host.room?.status === 'playing', '第二局');
  await settled();
  for (const p of players) await expectDice(p.page, null);
  await host.page.locator('[data-host=finish]').click();
  await host.page.locator('#again').waitFor();
  assert.equal(host.room.game.endReason, 'host');
  console.log('✓ 原座位再来一局，主持人提前结算');
}

async function localFlow() {
  const { page } = await player(1280, 800);
  await page.goto(base + '/local');
  await page.locator('[data-count="2"]').click();
  await page.locator('#start').click();
  await page.locator('[data-act=roll]:enabled').waitFor();
  await page.reload();
  await page.locator('[data-act=roll]:enabled').waitFor();
  assert.equal(await page.locator('#tabs .ptab').count(), 2);
  assert.equal(await page.locator('#board .cell').count(), 68);
  await expectDice(page, null);
  await page.evaluate(() => {
    // Exercise the exact 2 + 1 result from the production refresh regression.
    const random = Math.random, values = [0.2, 0.05];
    Math.random = () => values.length ? values.shift() : random();
    window.rollingCubes = [];
    for (const cube of document.querySelectorAll('#dice .cube')) {
      cube.addEventListener('transitionrun', e => {
        if (e.target === cube && e.propertyName === 'transform') window.rollingCubes.push(cube.id);
      });
    }
  });
  await page.locator('[data-act=roll]:enabled').click();
  await expectDice(page, [2, 1], true);
  assert.deepEqual(await page.evaluate(() => [...new Set(window.rollingCubes)].sort()), ['die0', 'die1']);
  await page.reload();
  await expectDice(page, [2, 1]);
  await page.locator('#newGame').click();
  await page.locator('[data-count="2"]').click();
  await page.locator('#start').click();
  await page.locator('[data-act=roll]:enabled').waitFor();
  await expectDice(page, null);
  console.log('✓ 同屏双人存档刷新恢复，骰面与存档一致，掷骰有旋转动画，新局回到初始骰面');
}

async function lobbyFlow() {
  const host = (await player(1280, 800)).page;
  const guest = (await player(375, 812)).page;
  const stamp = randomBytes(3).toString('hex');
  for (const [i, page] of [host, guest].entries()) {
    await page.goto(base + '/online');
    await page.locator('#loginForm [name=name]').fill('试玩' + i + stamp);
    await page.locator('#loginForm [name=password]').fill(randomBytes(12).toString('hex'));
    await page.locator('[data-mode=register]').click();
    await page.locator('#createForm').waitFor();
  }
  await host.locator('#createForm input[name=locked]').check();
  await host.locator('#createForm button').click();
  const code = await host.locator('.code').textContent();
  await guest.goto(base + '/t/' + code);
  await guest.locator('[data-do=ready]').click();
  await host.locator('[data-do=start]').click();
  await host.locator('.board .cell').last().waitFor();
  const positions = await host.locator('.board .cell').evaluateAll(cells => cells.map(el => el.style.gridArea));
  assert.equal(positions.length, 68);
  assert.equal(new Set(positions).size, 68);
  await guest.locator('[data-act=resign]').click();
  await host.locator('[data-do=again]').click();
  await guest.locator('[data-do=leave]').click();
  await host.locator('[data-do=leave]').click();
  console.log('✓ 账号注册、上锁建桌、邀请码、准备、68 格无重叠、结算和离桌');
}

try {
  await roomFlow();
  await localFlow();
  await lobbyFlow();
  assert.deepEqual(errors, [], '页面运行异常');
} finally {
  await browser.close();
}
