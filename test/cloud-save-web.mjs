// Cross-device saves and recovery through actual Chromium pages and the Worker.
// Usage: node test/cloud-save-web.mjs http://localhost:5200
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const base = new URL(process.argv[2] || 'http://localhost:5200').origin;
const browser = await chromium.launch({
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel:'chrome' }),
  args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']
});
const errors = [];
const pairKey = 'mf_cloud_pair_v1', localKey = 'mf_local_v2';
async function client() {
  const context = await browser.newContext({viewport:{width:1280,height:800},permissions:['clipboard-read','clipboard-write']});
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  return {page, context};
}
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw Error('等待超时：' + what);
}
const stored = (page,key) => page.evaluate(k => JSON.parse(localStorage.getItem(k)),key);
async function remote(p) {
  if (!p?.id) return null;
  const r=await fetch(base + '/api/saves/' + p.id,{headers:{Authorization:'Bearer '+p.token}});
  assert.equal(r.status,200);
  return r.json();
}
async function createGame(page) {
  await page.goto(base + '/local');
  await page.locator('[data-count="2"]').click();
  await page.locator('#start').click();
  await page.locator('#tabs .ptab').last().waitFor();
  await page.locator('[data-act=roll]:enabled').waitFor();
  return until(async () => {
    const local=await stored(page,localKey), p=await stored(page,pairKey);
    if (!p?.revision || local?.state?.events?.length !== 0) return false;
    const cloud=await remote(p);
    return JSON.stringify(cloud.slot) === JSON.stringify(local) && p;
  }, '建立并同步完整初始存档');
}
async function cloudDialog(page) {
  if (!(await page.locator('#cloudDialog').count())) await page.getByRole('button',{name:'云存档',exact:true}).click();
  return page.locator('#cloudDialog');
}
async function privateLink(page) {
  const dialog = await cloudDialog(page);
  await dialog.locator('[data-cloud=copy]:enabled').click();
  const link=await page.evaluate(()=>navigator.clipboard.readText());
  assert.match(new URL(link).hash,/^#save=[a-f0-9]{32}\.[a-f0-9]{64}$/);
  await dialog.locator('[data-cloud=close]').click();
  return link;
}
const choose = (page,id) => page.locator('#tabs [data-pid="'+id+'"]').click();

async function conflictsAndRecovery() {
  const a=await client(), b=await client(), c=await client();
  const source=await createGame(a.page);
  const share=await privateLink(a.page);
  const baseline=await remote(source);
  await b.page.goto(share);
  await b.page.locator('#tabs .ptab').last().waitFor();
  await until(() => b.page.evaluate(()=>!location.hash),'恢复成功后移除能力令牌');
  assert.deepEqual((await stored(b.page,localKey)).state,baseline.slot.state);
  await choose(b.page,'B');
  await until(async()=> (await remote(source)).slot.viewer === 'B','第二台设备同步视角');
  await a.page.evaluate(() => { Math.random = () => 0.4; });
  await a.page.locator('[data-act=roll]:enabled').click();
  const aDialog=await cloudDialog(a.page);
  await until(async()=> (await aDialog.locator('#cloudStatus').innerText()).includes('另存本局'), '旧修订写入提示冲突');
  const actual=await remote(source);
  assert.equal(actual.slot.state.seq,0);
  assert.equal(actual.slot.viewer,'B');
  await a.page.reload();
  const reopened=await cloudDialog(a.page);
  assert.match(await reopened.locator('#cloudStatus').innerText(),/另存本局/);
  await reopened.locator('[data-cloud=retry]').click();
  await until(async()=>{const p=await stored(a.page,pairKey);return p?.id && p.id !== source.id && p.revision>0;}, '另存冲突分支');
  assert.deepEqual(await remote(source),actual,'另存不修改原远程版本');
  console.log('✓ 私有链接跨设备恢复整局与牌堆，同步分歧保留本机与远端两条进度');

  // v1 metadata lacked a match identity and a pending-job journal. An old
  // revision and a same-sequence divergent view must still be detected on load.
  await c.context.addInitScript(({source,slot,localKey,pairKey})=>{
    if (localStorage.getItem('seeded')) return;
    localStorage.setItem('seeded','1');
    localStorage.setItem(pairKey,JSON.stringify(source));
    localStorage.setItem(localKey,JSON.stringify(slot));
  }, {source:{id:source.id,token:source.token,revision:baseline.revision},slot:baseline.slot,localKey,pairKey});
  await c.page.goto(base+'/local');
  const legacy=await cloudDialog(c.page);
  await until(async()=> (await legacy.locator('#cloudStatus').innerText()).includes('另存本局'),'刷新时发现旧版修订冲突');
  assert.deepEqual(await remote(source),actual);
  console.log('✓ 旧版存档游标在启动时得到核验，冲突提示跨刷新保留');
  return {source, share};
}

async function retryRecovery(share, source) {
  const {page,context} = await client();
  const pattern = '**/api/saves/' + source.id;
  // Keep HTML/assets reachable while the remote save read is unavailable.
  await page.route(pattern, r => r.abort('failed'));
  await page.goto(share);
  await page.locator('#start').waitFor();
  await until(()=>page.evaluate(()=>!!location.hash),'未联网时保留恢复链接');
  await context.setOffline(true);
  await page.unroute(pattern);
  await context.setOffline(false);
  await until(()=>page.evaluate(()=>!location.hash), '联网后重新验证恢复链接');
  assert.deepEqual(await stored(page,localKey), (await remote(source)).slot);
  await page.evaluate(k=>localStorage.removeItem(k), localKey);
  await page.reload();
  await until(()=>stored(page,localKey),'本地棋盘缺失时通过本机能力恢复');
  assert.deepEqual(await stored(page,localKey), (await remote(source)).slot);
  console.log('✓ 存档暂时不可读取后重新联网可自动恢复，本机棋盘数据丢失也可恢复');
}

async function incomingDuringPlay(share, source) {
  const {page} = await client();
  const own=await createGame(page);
  const original=(await remote(own)).slot.state.startedAt;
  const targetBefore=await remote(source);
  let captured, release;
  const gate = new Promise(resolve=>{release=resolve;});
  await page.route('**/api/saves/'+source.id,async route=>{
    if (route.request().method() !== 'GET') throw Error('恢复候选链接在校验前被写入');
    captured=true;
    const response=await route.fetch();
    await gate; await route.fulfill({response});
  });
  // Full navigation runs startup again; changing only a fragment on an open page does not.
  await page.goto(base+'/');
  await page.goto(share);
  await until(()=>captured,'等待链接读取');
  await choose(page,'B');
  release();
  await until(async()=>!(await page.evaluate(()=>location.hash)),'本机操作取消待处理的导入');
  await until(async()=>(await remote(own)).slot.viewer === 'B','原档安全同步');
  assert.equal((await stored(page,pairKey)).id,own.id);
  assert.equal((await stored(page,localKey)).state.startedAt,original);
  assert.deepEqual(await remote(source),targetBefore);
  await page.unroute('**/api/saves/'+source.id);

  const bad='#save='+source.id+'.'+randomBytes(32).toString('hex');
  await page.goto(base+'/'); await page.goto(base+'/local'+bad);
  await until(async()=>!(await page.evaluate(()=>location.hash)),'无效令牌未保留在当前页面');
  assert.equal((await stored(page,pairKey)).id,own.id);
  await choose(page,'A');
  await until(async()=>(await remote(own)).slot.viewer === 'A','使用失效链接仍可更新原档');
  assert.deepEqual(await remote(source),targetBefore);
  console.log('✓ 恢复请求中继续本地操作、失效链接均不会换绑或改写另一局');
}

async function offlineSwitchAndRetry() {
  const {page,context}=await client();
  const old=await createGame(page);
  // Lose an accepted write's response. A newer pending move must survive the
  // ensuing revision conflict and switching the active local game.
  const endpoint='**/api/saves/'+old.id;
  let dropped=false;
  await page.route(endpoint,async route=>{
    if (route.request().method()==='PUT' && !dropped) {
      await route.fetch(); dropped=true; await route.abort('failed');
    } else await route.continue();
  });
  await choose(page,'B');
  await until(()=>dropped,'模拟已提交但响应丢失');
  await context.setOffline(true);
  await choose(page,'A');
  const finalOld=await stored(page,localKey);
  await page.locator('#newGame').click();
  await page.locator('[data-count="3"]').click();
  await page.locator('#start').click();
  await page.locator('#tabs .ptab').nth(2).waitFor();
  const newLocal=await stored(page,localKey);
  assert.notEqual(newLocal.state.startedAt,finalOld.state.startedAt);
  assert.equal(newLocal.state.players.length,3);
  await page.unroute(endpoint);
  // The static page is available again while the save API remains unavailable.
  // Reload reads both queues from disk, then reconnect through the normal retry UI.
  await page.route('**/api/saves**',r=>r.abort('failed'));
  await context.setOffline(false);
  await page.reload();
  await page.locator('#tabs .ptab').nth(2).waitFor();
  const dialog=await cloudDialog(page);
  await until(async()=>(await dialog.locator('#cloudStatus').innerText()).includes('旧存档'),'重开后仍报告旧局待传');
  await page.unroute('**/api/saves**');
  await dialog.locator('[data-cloud=retry]').click();
  const now=await until(async()=>{const p=await stored(page,pairKey);return p?.id && p.id!==old.id && p.revision>0 && p;},'新局获得独立存档');
  await until(async()=>{const r=await remote(old);return JSON.stringify(r.slot) === JSON.stringify(finalOld);}, '丢失响应后旧局的最后一步持久上传');
  assert.equal((await remote(now)).slot.state.startedAt,newLocal.state.startedAt);
  console.log('✓ 已接受但响应丢失、断网切换新局和刷新后，两个存档均正确同步');
}
try {
  const {source,share}=await conflictsAndRecovery();
  await retryRecovery(share,source);
  await incomingDuringPlay(share,source);
  await offlineSwitchAndRetry();
  assert.deepEqual(errors,[], '浏览器页面错误');
} finally { await browser.close(); }
