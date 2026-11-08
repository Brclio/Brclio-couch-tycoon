// 共用棋盘。单机对局在本地执行引擎，好友房间只播放服务器已裁决的动作。
import './board-layout.js';
import { boardPosition } from './board-position.js';
import { startCloudSave, queueCloudSave, newCloudGame, showCloudSave } from './cloud-save.js';
import {
  SQUARES, GROUPS, baseRent, HOUSE_MULT, AIRPORT_RENT, mortgageValue, unmortgageCost,
  JAIL_FINE, START_CASH, AVATAR_BONUS, CHARS, GO_SALARY, PLAYER_COLORS, BUILD_PER_STOP, JAIL_POS, AIRPORTS, LONG_SIDE, SHORT_SIDE, BOARD_SIZE,
} from '/shared/board.js';
import { createGame, act, legalActions, current, totalOwed, player, saleCost, rentFor } from '/shared/engine.js';
import { sfx, speak, stopSpeech, prefetchSpeech, unlock, getPrefs, setPref } from '/sfx.js';

const KEY = 'mf_local_v2';   // v2：68 格棋盘，旧存档不兼容
// 远程房间的棋盘只展示服务器快照；同屏页可在浏览器里直接执行动作。
const PARTY = document.body.classList.contains('room-page');
if (PARTY) document.body.classList.add('party');
const LETTERS = 'ABCDEF';
const DURATION_MIN = 60;

const charName = (code) => CHARS.find(c => c.code === code)?.name || '';
const FACE = { good: '1f929', bad: '1f62d', neutral: '1f914', pay: '1f62c', jail: '1f631', party: '1f973' };

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const ctx = () => ({ now: Date.now(), rng: Math.random });

const G = {
  state: null,
  viewer: null,     // 当前以哪个玩家的身份操作
  feed: [],         // 银行流水
  selected: null,   // 选中的格子
  busy: false,      // 正在播放动画
  disp: null,       // 动画过程中显示的位置和现金
  dice: [6, 6],
  spins: 0,
};

// ---------- 存档 ----------

function save() {
  if (PARTY) return;
  const snapshot = { state: G.state, viewer: G.viewer, feed: G.feed.slice(0, 40) };
  try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch {}
  queueCloudSave(snapshot);
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
function clearSaved() {
  newCloudGame();
  try { localStorage.removeItem(KEY); } catch {}
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

// 玩家头像：有角色就用角色图标，老存档没有角色时退回字母
function avatar(p, cls = '') {
  const inner = p.avatar ? `<img src="/avatars/${encodeURIComponent(p.avatar)}.webp" alt="" draggable="false">` : esc([...p.name][0]);
  return `<span class="av ${cls}" style="--c:${esc(p.color)}">${inner}</span>`;
}

// ---------- 棋盘 ----------

// 长方形棋盘：横屏时长边在上下；竖屏手机把整个棋盘转置，长边变成左右
const L = LONG_SIDE, S = SHORT_SIDE;
const portrait = () => window.innerWidth < 760 && window.innerHeight > window.innerWidth;
function cellPos(i) {
  return boardPosition(i, G.portrait);
}
function sideOf(i) {
  const [r, c] = cellPos(i);
  const rows = G.portrait ? L + 2 : S + 2, cols = G.portrait ? S + 2 : L + 2;
  if ((r === 1 || r === rows) && (c === 1 || c === cols)) return 'corner';
  return r === rows ? 'bottom' : r === 1 ? 'top' : c === 1 ? 'left' : 'right';
}

const ICON = {
  airport: '<svg viewBox="0 0 24 24"><path d="M21 15v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5.5z" fill="currentColor"/></svg>',
  electric: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>',
  water: '<svg viewBox="0 0 24 24"><path d="M12 2.5C9 7 6 10.5 6 14a6 6 0 0 0 12 0c0-3.5-3-7-6-11.5z" fill="currentColor"/></svg>',
  tax: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>',
  go: '<svg viewBox="0 0 40 24"><path d="M38 12H6m9-9-9 9 9 9" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  parking: '<svg viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 18V6h4.2a3.6 3.6 0 0 1 0 7.2H9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  police: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="currentColor"/><path d="m12 7 1.3 2.7 3 .4-2.2 2.1.5 3-2.6-1.4-2.6 1.4.5-3-2.2-2.1 3-.4z" fill="#fff"/></svg>',
  bank: '<svg viewBox="0 0 48 48"><path d="M24 4 4 14v4h40v-4z" fill="currentColor"/><rect x="8" y="20" width="5" height="16" rx="1" fill="currentColor"/><rect x="17" y="20" width="5" height="16" rx="1" fill="currentColor"/><rect x="26" y="20" width="5" height="16" rx="1" fill="currentColor"/><rect x="35" y="20" width="5" height="16" rx="1" fill="currentColor"/><rect x="4" y="38" width="40" height="5" rx="1" fill="currentColor"/></svg>',
  soundOn: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="m16 9 6 6m0-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  voice: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

let cellEls = [];

function buildBoard() {
  const board = $('board');
  G.portrait = portrait();
  const rows = G.portrait ? L + 2 : S + 2, cols = G.portrait ? S + 2 : L + 2;
  board.style.gridTemplateColumns = `1.6fr repeat(${cols - 2}, 1fr) 1.6fr`;
  board.style.gridTemplateRows = `1.6fr repeat(${rows - 2}, 1fr) 1.6fr`;
  board.classList.toggle('portrait', G.portrait);
  $('center').style.gridArea = `2 / 2 / ${rows} / ${cols}`;
  board.querySelectorAll('.cell').forEach(c => c.remove());
  cellEls = SQUARES.map((sq) => {
    const [r, c] = cellPos(sq.index);
    const el = document.createElement('button');
    el.className = `cell side-${sideOf(sq.index)} t-${sq.type}${sq.util ? ` util-${sq.util}` : ''}`;
    el.style.gridArea = `${r}/${c}`;
    el.dataset.i = sq.index;
    el.innerHTML = cellInner(sq);
    board.insertBefore(el, $('center'));
    return el;
  });
}

function cellInner(sq) {
  if (sq.type === 'go') return `<div class="corner-go"><b>起点</b><span>经过领 ${money(GO_SALARY)}</span><i>${ICON.go}</i></div>`;
  if (sq.type === 'jail') return `<div class="corner-jail"><div class="cell-jail"><b>监狱</b></div><span class="visit">探监</span></div>`;
  if (sq.type === 'parking') return `<div class="corner-plain"><i>${ICON.parking}</i><b>免费停车</b></div>`;
  if (sq.type === 'gotojail') return `<div class="corner-plain police"><i>${ICON.police}</i><b>入狱</b></div>`;
  const band = sq.group ? `<div class="band" style="--g:${GROUPS[sq.group].color}"><span class="houses"></span></div>` : '';
  const price = sq.price ? money(sq.price) : sq.type === 'tax' ? `付 ${money(sq.amount)}` : '';
  return `${band}<div class="cell-body">${squareArt(sq)}<div class="txt"><div class="name">${esc(sq.name)}</div>${price ? `<div class="price">${price}</div>` : ''}</div></div><span class="owner"></span>`;
}

function squareArt(sq, cls = '') {
  if (sq.flag) return `<img class="flag ${cls}" src="/flags/${sq.flag}.svg" alt="">`;
  if (sq.type === 'airport') return `<i class="ic airport ${cls}">${ICON.airport}</i>`;
  if (sq.type === 'utility') return `<i class="ic util ${cls}">${sq.util === 'electric' ? ICON.electric : ICON.water}</i>`;
  if (sq.type === 'tax') return `<i class="ic tax ${cls}">${ICON.tax}</i>`;
  if (sq.type === 'chance') return `<i class="ic q chance ${cls}">?</i>`;
  if (sq.type === 'fate') return `<i class="ic q fate ${cls}">!</i>`;
  if (sq.type === 'jail') return `<i class="ic jailic ${cls}">${ICON.police}</i>`;
  return '';
}

// 归属、房子、抵押
function updateCells() {
  const s = G.state;
  for (const sq of SQUARES) {
    const el = cellEls[sq.index];
    const pr = s?.props[sq.index];
    const owner = pr && player(s, pr.owner);
    el.classList.toggle('owned', !!owner);
    el.classList.toggle('mortgaged', !!pr?.mortgaged);
    el.classList.toggle('sel', G.selected === sq.index);
    el.style.setProperty('--o', owner ? owner.color : 'transparent');
    const o = el.querySelector('.owner');
    if (o) o.innerHTML = owner ? (owner.avatar ? `<img src="/avatars/${encodeURIComponent(owner.avatar)}.webp" alt="">` : esc([...owner.name][0])) : '';
    const h = el.querySelector('.houses');
    if (h) {
      const n = pr?.houses || 0;
      h.innerHTML = n === 5 ? '<i class="hotel"></i>' : '<i class="house"></i>'.repeat(n);
    }
  }
}

// ---------- 棋子 ----------

function tokenEl(p) {
  let el = document.querySelector(`.tk[data-pid="${p.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'tk';
    el.dataset.pid = p.id;
    el.innerHTML = p.avatar ? `<span><img src="/avatars/${encodeURIComponent(p.avatar)}.webp" alt="" draggable="false"></span>` : `<span>${esc([...p.name][0])}</span>`;
    $('tokens').appendChild(el);
  }
  el.style.setProperty('--c', p.color);
  return el;
}

const OFFSETS = [[0, 0], [-1, -1], [1, 1], [1, -1], [-1, 1], [0, -1.4], [0, 1.4]];

function placeTokens(animate = true, only = null) {
  const s = G.state;
  if (!s) { $('tokens').innerHTML = ''; return; }
  const d = G.disp;
  const b = $('board').getBoundingClientRect();
  const groups = {};
  for (const p of s.players) {
    if (p.bankrupt && !(d && d.alive?.[p.id])) {
      document.querySelector(`.tk[data-pid="${p.id}"]`)?.remove();
      continue;
    }
    const pos = d ? d.pos[p.id] : p.pos;
    const jailed = d ? d.jail[p.id] : p.inJail;
    const key = `${pos}-${jailed && pos === JAIL_POS ? 'j' : 'v'}`;
    (groups[key] ||= []).push(p);
  }
  for (const [key, list] of Object.entries(groups)) {
    const [pos, jv] = key.split('-');
    const c = cellEls[pos].getBoundingClientRect();
    let cx = c.left - b.left + c.width / 2, cy = c.top - b.top + c.height / 2;
    if (+pos === JAIL_POS) {
      if (jv === 'j') { cx = c.left - b.left + c.width * 0.62; cy = c.top - b.top + c.height * 0.38; }
      else { cx = c.left - b.left + c.width * 0.2; cy = c.top - b.top + c.height * 0.8; }
    }
    const r = Math.min(c.width, c.height) * (list.length > 1 ? 0.2 : 0);
    list.forEach((p, k) => {
      const el = tokenEl(p);
      const [ox, oy] = OFFSETS[k % OFFSETS.length];
      const size = el.offsetWidth || 24;
      el.classList.toggle('no-anim', !animate);
      el.classList.toggle('cur', s.status === 'playing' && current(s).id === p.id);
      if (only && only !== p.id && el.style.transform) return;
      el.style.transform = `translate(${cx + ox * r - size / 2}px, ${cy + oy * r - size / 2}px)`;
    });
  }
}

// 宽屏：棋盘铺满左边全部宽度和一屏高度；窄屏：按棋盘本身的长宽比
function fitBoard() {
  if (portrait() !== G.portrait) {
    buildBoard();
    updateCells();
    $('tokens').innerHTML = '';
  }
  const board = $('board');
  const area = $('boardArea');
  const rows = G.portrait ? L + 2 : S + 2, cols = G.portrait ? S + 2 : L + 2;
  const w = area.clientWidth;
  const units = (n) => n - 2 + 3.2;
  const h = window.innerWidth > 1100
    ? Math.max(window.innerHeight - $('bar').offsetHeight - 24, w / units(cols) * units(rows) * 0.8)
    : w / units(cols) * units(rows);
  board.style.width = `${w}px`;
  board.style.height = `${h}px`;
  const unit = Math.min(w / units(cols), h / units(rows));
  board.style.fontSize = `${Math.max(5, unit / 5.4)}px`;
  placeTokens(false);
}

// ---------- 骰子 ----------

const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const FACE_ORDER = [1, 2, 6, 5, 3, 4]; // 前 右 后 左 上 下
const SHOW = { 1: [0, 0], 2: [0, -90], 6: [0, 180], 5: [0, 90], 3: [-90, 0], 4: [90, 0] };

function buildDice() {
  for (const k of [0, 1]) {
    $(`die${k}`).innerHTML = FACE_ORDER.map((n, f) =>
      `<div class="face f${f}">${Array.from({ length: 9 }, (_, j) => `<i class="${PIPS[n].includes(j) ? 'on' : ''}"></i>`).join('')}</div>`).join('');
  }
  setDice(G.dice, false);
}

function setDice(d, spin) {
  if (spin) G.spins++;
  d.forEach((n, k) => {
    const [x, y] = SHOW[n];
    const extra = G.spins * 360 * (k ? -1 : 1);
    const cube = $(`die${k}`);
    cube.classList.toggle('no-anim', !spin);
    cube.style.transform = `rotateX(${x + extra * 2}deg) rotateY(${y + extra}deg)`;
  });
}

// ---------- 弹框：等人看清楚、点一下再继续 ----------

function ask({ tone = 'pay', face, art = '', title, lines = [], html = '', from, to, amount, button, say, pid }) {
  const layer = $('prompt');
  const party = (x) => x === 'bank'
      ? `<span class="pp"><span class="av bankav">${ICON.bank}</span><b>银行</b></span>`
      : x ? `<span class="pp">${avatar(x, 'lg')}<b>${esc(x.name)}</b></span>` : '';
  layer.innerHTML = `
    <div class="pbox tone-${tone}">
      <div class="phead">${art}<div class="ptitle">${esc(title)}</div>${face ? `<img class="pface" src="/avatars/${face}.webp" alt="">` : ''}</div>
      <div class="pbody">
        ${lines.map(l => `<p>${l}</p>`).join('')}
        ${html}
        ${from || to ? `<div class="pflow">${party(from)}<span class="parrow"><b>${amount != null ? money(amount) : ''}</b><i></i></span>${party(to)}</div>` : ''}
        <button class="btn ${tone === 'good' ? 'gold' : 'primary'} big" id="pok">${esc(button)}</button>
        <div class="pkey">${PARTY ? '' : '按空格或回车也可以'}</div>
      </div>
    </div>`;
  layer.classList.add('show');
  sfx.pop();
  if (say) speak(say);
  return waitForButton($('pok'), pid).then(async () => {
    stopSpeech();
    layer.classList.remove('show');
    await sleep(180);
  });
}

async function waitForButton(button, pid) {
  if (!PARTY) {
    await new Promise(resolve => {
      const done = () => { document.removeEventListener('keydown', key); resolve(); };
      const key = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); done(); } };
      button.onclick = done;
      document.addEventListener('keydown', key);
    });
    return;
  }
  // The server may have received the confirmation before the animation reached it.
  const waiting = P.room?.waitingFor;
  if (!waiting || waiting.seq !== G.state.seq || waiting.eventIndex !== P.eventIndex || waiting.pid !== pid) {
    button.hidden = true;
    await sleep(450);
    return;
  }
  const mine = pid === P.me;
  button.disabled = !mine;
  button.textContent = mine ? waiting.button : `等 ${player(G.state, pid).name} 确认`;
  await new Promise(resolve => {
    P.prompt = { id: waiting.id, resolve };
    button.onclick = () => {
      if (mine && !P.room.paused) P.send({ t: 'ack', seq: waiting.seq, id: waiting.id });
    };
  });
}

// ---------- 动画 ----------

function tabEl(pid) { return document.querySelector(`.ptab[data-pid="${pid}"]`); }
function centerOf(el) {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

function floatText(el, text, cls) {
  if (!el) return;
  const [x, y] = centerOf(el);
  const f = document.createElement('div');
  f.className = `float ${cls}`;
  f.textContent = text;
  f.style.left = `${x}px`; f.style.top = `${y}px`;
  $('fx').appendChild(f);
  setTimeout(() => f.remove(), 1500);
}

function confetti(n = 60) {
  const colors = ['#f5c451', '#4ade80', '#60a5fa', '#f472b6', '#fb923c', '#a78bfa'];
  for (let k = 0; k < n; k++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = `${50 + (Math.random() - 0.5) * 30}vw`;
    c.style.top = '42vh';
    c.style.background = colors[k % colors.length];
    $('fx').appendChild(c);
    const dx = (Math.random() - 0.5) * 900, dy = -200 - Math.random() * 300;
    c.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.6}px, ${dy}px) rotate(${Math.random() * 540}deg)`, opacity: 1, offset: 0.4 },
      { transform: `translate(${dx}px, ${dy + 700}px) rotate(${Math.random() * 1080}deg)`, opacity: 0 },
    ], { duration: 1600 + Math.random() * 800, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = () => c.remove();
  }
}

async function flyMoney(e) {
  const src = e.from ? tabEl(e.from) : $('vault');
  const dst = e.to ? tabEl(e.to) : $('vault');
  if (src && dst) {
    const [x0, y0] = centerOf(src), [x1, y1] = centerOf(dst);
    const n = Math.min(6, Math.max(2, Math.ceil(e.amount / 120)));
    sfx.whoosh();
    floatText(src, `-${money(e.amount)}`, 'neg');
    for (let k = 0; k < n; k++) {
      const b = document.createElement('img');
      b.className = 'bill';
      b.src = '/avatars/1f4b5.webp';
      b.style.left = `${x0}px`; b.style.top = `${y0}px`;
      $('fx').appendChild(b);
      const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 90 - k * 8;
      b.animate([
        { transform: 'translate(-50%,-50%) scale(.5) rotate(0deg)', opacity: 0 },
        { transform: `translate(calc(${mx - x0}px - 50%), calc(${my - y0}px - 50%)) scale(1.15) rotate(${k % 2 ? -18 : 18}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(calc(${x1 - x0}px - 50%), calc(${y1 - y0}px - 50%)) scale(.7) rotate(0deg)`, opacity: 0.9 },
      ], { duration: 820, delay: k * 90, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' }).onfinish = () => b.remove();
    }
    await sleep(760 + n * 90);
    if (e.to) sfx.coinIn(); else sfx.register();
    floatText(dst, `+${money(e.amount)}`, 'pos');
    dst.classList.remove('gotcash'); void dst.offsetWidth; dst.classList.add('gotcash');
  }
  const d = G.disp;
  if (e.from) d.cash[e.from] -= e.amount; else d.bankOut += e.amount;
  if (e.to) d.cash[e.to] += e.amount; else d.bankIn += e.amount;
  if (!e.from || !e.to) { $('vault')?.classList.remove('pulse'); void $('vault')?.offsetWidth; $('vault')?.classList.add('pulse'); }
  G.feed.unshift({ ...e, round: G.state.round });
  if (G.feed.length > 100) G.feed.length = 100;
  renderTabs();
  renderBankStats();
  renderFeed();
  await sleep(250);
}

async function walk(e) {
  const d = G.disp;
  const fast = e.steps > 12;
  for (let k = 0; k < e.steps; k++) {
    d.pos[e.pid] = (d.pos[e.pid] + e.dir + BOARD_SIZE) % BOARD_SIZE;
    placeTokens(true, e.pid);
    const el = document.querySelector(`.tk[data-pid="${e.pid}"]`);
    el?.classList.remove('hop'); void el?.offsetWidth; el?.classList.add('hop');
    sfx.step(k);
    await sleep(fast ? 80 : 170);
  }
  placeTokens(true);
  await sleep(220);
}

async function goJail(e) {
  const d = G.disp;
  const p = player(G.state, e.pid);
  if (e.reason === 'square' || e.reason === 'doubles') {
    await ask({
      tone: 'bad', face: FACE.jail, art: `<i class="ic jailic">${ICON.police}</i>`,
      title: e.reason === 'square' ? '停在了「入狱」格' : '连续 3 次掷出双数',
      lines: [`${esc(p.name)} 要直接进监狱。`, '不经过起点，不领工资。出狱方法：交 $50、用出狱卡，或者掷出双数。'],
      button: '唉，进去吧',
      say: lineFor(e),
      pid: e.pid,
    });
  }
  sfx.jail();
  const jail = cellEls[JAIL_POS];
  jail.classList.remove('slam'); void jail.offsetWidth; jail.classList.add('slam');
  d.pos[e.pid] = JAIL_POS; d.jail[e.pid] = true;
  const el = document.querySelector(`.tk[data-pid="${e.pid}"]`);
  el?.classList.add('slow');
  placeTokens(true);
  await sleep(900);
  el?.classList.remove('slow');
}

// 要播报的话。动画开始前就把整串事件的话发给服务器合成，等弹框出来时录音多半已经好了
function lineFor(e) {
  const s = G.state;
  const p = player(s, e.pid);
  if (e.k === 'card') return `${e.deck === 'chance' ? '机会' : '命运'}：${e.text}`;
  if (e.k === 'jail') {
    if (e.reason === 'square') return `${p.name}停在了入狱格，直接进监狱！`;
    if (e.reason === 'doubles') return `${p.name}连续三次双数，直接进监狱！`;
    return null;
  }
  if (e.k === 'bankruptcy') {
    const who = e.to ? player(s, e.to).name : '银行';
    const n = e.props.length;
    return `${p.name}破产了！${n ? `${n}个国家` : ''}${n && e.cash ? '和' : ''}${e.cash ? `现金 $${e.cash}` : ''}${n || e.cash ? `，全部归${who}` : ''}`;
  }
  if (e.k !== 'charge') return null;
  const sq = SQUARES[e.square];
  if (e.kind === 'tax') return `${p.name}停在了${sq.name}，要交税 $${e.amount}`;
  if (e.kind === 'jailfine') return `${p.name}坐牢满三回合，交罚金 $${e.amount}`;
  if (e.kind === 'rent') return `${p.name}停在了${player(s, e.to).name}的${sq.name}，要付过路费 $${e.amount}`;
  return null;
}

// 停格扣款：先弹框说清楚，再让钱飞
async function charge(e) {
  const s = G.state;
  const p = player(s, e.pid);
  const sq = SQUARES[e.square];
  if (e.kind === 'mortgaged') {
    sfx.neutral();
    toast(`${sq.name} 已经抵押，这次不用付过路费`);
    await sleep(900);
    return;
  }
  if (e.kind === 'tax') {
    await ask({
      tone: 'pay', face: FACE.pay, art: squareArt(sq, 'big'),
      title: sq.name,
      lines: [`${esc(p.name)} 停在了「${esc(sq.name)}」格，要向银行交税。`],
      from: p, to: 'bank', amount: e.amount,
      button: `交税 ${money(e.amount)}`,
      say: lineFor(e),
      pid: e.pid,
    });
    return;
  }
  if (e.kind === 'jailfine') {
    await ask({
      tone: 'pay', face: FACE.pay, art: squareArt(sq, 'big'),
      title: '坐牢满 3 回合',
      lines: [`${esc(p.name)} 第 3 回合还没掷出双数，必须交罚金出狱，然后按点数前进。`],
      from: p, to: 'bank', amount: e.amount,
      button: `交罚金 ${money(e.amount)}`,
      say: lineFor(e),
      pid: e.pid,
    });
    return;
  }
  // 过路费
  const owner = player(s, e.to);
  const pr = s.props[e.square];
  const what = sq.type === 'country'
    ? (pr?.houses === 5 ? '有一座酒店' : pr?.houses ? `有 ${pr.houses} 栋房` : '还是空地')
    : sq.type === 'airport' ? `${esc(owner.name)} 有 ${AIRPORTS.filter(i => s.props[i]?.owner === owner.id).length} 个机场`
      : `骰子点数 ${s.dice[0] + s.dice[1]}，按公司数量算`;
  await ask({
    tone: 'pay', face: FACE.pay, art: squareArt(sq, 'big'),
    title: `${owner.name} 的${sq.name}`,
    lines: [`${esc(p.name)} 停在了 ${esc(owner.name)} 的「${esc(sq.name)}」，${what}。`, e.mult > 1 ? '机会卡：这次付双倍过路费。' : ''].filter(Boolean),
    from: p, to: owner, amount: e.amount,
    button: `付过路费 ${money(e.amount)}`,
    say: lineFor(e),
    pid: e.pid,
  });
}

// 破产：先说清楚谁破产、欠谁、哪些国家和多少现金归谁，点确认后再动
async function bankruptcyPrompt(e) {
  const s = G.state;
  const p = player(s, e.pid);
  const heir = e.to ? player(s, e.to) : null;
  const heirName = heir ? heir.name : '银行';
  const list = e.props.map(x => {
    const sq = SQUARES[x.square];
    const tags = [x.mortgaged ? '<em class="bk-mort">抵押中</em>' : '', x.houses ? `<em class="bk-house">拆 ${x.houses === 5 ? '酒店' : `${x.houses} 栋房`}</em>` : ''].join('');
    return `<li>${squareArt(sq, 'bk-art')}<span>${esc(sq.name)}</span>${tags}</li>`;
  }).join('');
  const html = `
    <div class="bk">
      ${e.props.length ? `<div class="bk-label">${e.props.length} 处地产 → ${esc(heirName)}</div><ul class="bk-list">${list}</ul>` : '<div class="bk-label">没有地产</div>'}
      ${heir && e.props.some(x => x.mortgaged) ? `<div class="bk-note">抵押中的国家照样归 ${esc(heir.name)}，还是抵押状态，要 ${esc(heir.name)} 自己还贷才能收租。</div>` : ''}
      ${!heir && e.props.length ? '<div class="bk-note">欠的是银行：国家全部收回，变成无主，谁停上去都能买。</div>' : ''}
      ${e.houseCash ? `<div class="bk-note">房子按半价卖回银行，得 ${money(e.houseCash)}，算进现金。</div>` : ''}
    </div>`;
  sfx.sad();
  await ask({
    tone: 'bad', face: '1f62d', art: avatar(p, 'lg'),
    title: `${p.name} 破产了`,
    lines: [`欠 ${heir ? esc(heir.name) : '银行'} ${money(e.owed)}，卖房、抵押之后还是不够，出局。`],
    html,
    from: p, to: heir || 'bank', amount: e.cash,
    button: heir ? `全部交给 ${heir.name}` : '全部收回银行',
    say: lineFor(e),
    pid: e.pid,
  });
}

// 国家一块块飞到新主人头像上（欠银行就飞回银行），格子上的主人标记跟着换
async function transferProps(e) {
  const s = G.state;
  const heir = e.to ? player(s, e.to) : null;
  for (const x of e.props) await flyPropTo(x.square, heir);
  toast(heir ? `${e.props.length} 处地产已归 ${heir.name}` : '地产已全部收回银行');
  await sleep(400);
}

// 一块地飞到新主人头像上（heir 为空就飞回银行），格子上的主人标记跟着换
async function flyPropTo(square, heir) {
  const sq = SQUARES[square];
  const cell = cellEls[square];
  const dst = heir ? tabEl(heir.id) : $('vault');
  if (dst) {
    const [x0, y0] = centerOf(cell), [x1, y1] = centerOf(dst);
    const f = document.createElement('div');
    f.className = 'flyprop';
    f.innerHTML = squareArt(sq);
    f.style.left = `${x0}px`; f.style.top = `${y0}px`;
    $('fx').appendChild(f);
    sfx.whoosh();
    await f.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(${(x1 - x0) / 2}px - 50%), calc(${Math.min(y0, y1) - y0 - 80}px - 50%)) scale(1.6)`, opacity: 1, offset: 0.4 },
      { transform: `translate(calc(${x1 - x0}px - 50%), calc(${y1 - y0}px - 50%)) scale(.5)`, opacity: .6 },
    ], { duration: 650, easing: 'cubic-bezier(.3,.7,.4,1)' }).finished;
    f.remove();
  }
  const o = cell.querySelector('.owner');
  if (heir) {
    cell.style.setProperty('--o', heir.color);
    if (o) o.innerHTML = heir.avatar ? `<img src="/avatars/${encodeURIComponent(heir.avatar)}.webp" alt="">` : esc([...heir.name][0]);
    sfx.stamp();
    stamp(square);
  } else {
    cell.querySelector('.houses')?.replaceChildren();
    cell.classList.remove('owned', 'mortgaged');
    sfx.register();
  }
  dst?.classList.remove('gotcash'); void dst?.offsetWidth; dst?.classList.add('gotcash');
  await sleep(120);
}

// ---------- 卖地给其他玩家 ----------

const houseText = (n) => n === 5 ? '一座酒店' : n ? `${n} 栋房` : '';

function rentNow(idx) {
  return rentFor(G.state, idx, G.state.dice?.reduce((sum, die) => sum + die, 0) || 7);
}

// 第一步：卖家定价，默认 = 成本 + $100
function pickPrice(idx) {
  const s = G.state, sq = SQUARES[idx], pr = s.props[idx];
  const cost = saleCost(s, idx);
  const h = GROUPS[sq.group]?.house || 0;
  let price = cost + 100;
  return new Promise((resolve) => {
    const layer = $('prompt');
    layer.innerHTML = `
      <div class="pbox tone-sale">
        <div class="phead">${squareArt(sq, 'big')}<div class="ptitle">出售${esc(sq.name)}</div></div>
        <div class="pbody">
          <p>连地带房子一起卖给其他玩家，谁出得起谁就能买。</p>
          <table class="sale-cost">
            <tr><td>地价</td><td>${money(sq.price)}</td></tr>
            ${pr.houses ? `<tr><td>${houseText(pr.houses)}（每栋 ${money(h)}）</td><td>${money(pr.houses * h)}</td></tr>` : ''}
            <tr class="sum"><td>成本</td><td>${money(cost)}</td></tr>
          </table>
          ${pr.mortgaged ? `<p class="sale-warn">这块地抵押中，买家接手后要自己还贷 ${money(unmortgageCost(sq))} 才能收租。</p>` : ''}
          <div class="stepper">
            <button class="btn" data-d="-100">-100</button><button class="btn" data-d="-10">-10</button>
            <input id="salePrice" inputmode="numeric" value="${price}" aria-label="要价">
            <button class="btn" data-d="10">+10</button><button class="btn" data-d="100">+100</button>
          </div>
          <div class="sale-diff" id="saleDiff"></div>
          <div class="pbtns"><button class="btn" id="saleNo">算了</button><button class="btn gold big" id="saleOk"></button></div>
        </div>
      </div>`;
    layer.classList.add('show');
    sfx.pop();
    const inp = $('salePrice');
    const show = () => {
      const d = price - cost;
      $('saleDiff').innerHTML = d >= 0 ? `比成本多赚 <b class="pos">${money(d)}</b>` : `比成本少 <b class="neg">${money(-d)}</b>`;
      $('saleOk').textContent = `挂出 ${money(price)}`;
    };
    show();
    layer.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { price = Math.max(10, price + +b.dataset.d); inp.value = price; sfx.step(0); show(); });
    inp.oninput = () => { price = Math.max(1, Math.round(+inp.value.replace(/\D/g, '')) || 1); show(); };
    const close = (v) => { layer.classList.remove('show'); setTimeout(() => resolve(v), 180); };
    $('saleNo').onclick = () => close(null);
    $('saleOk').onclick = () => close(price);
  });
}

// 第二步：大家都看到这块地在卖，买得起的人点自己的头像买下
function showOffer() {
  const s = G.state, o = s.offer;
  const seller = player(s, o.from), sq = SQUARES[o.square], pr = s.props[o.square];
  const buyers = s.players.filter(p => p.id !== seller.id && !p.bankrupt);
  return new Promise((resolve) => {
    const layer = $('prompt');
    layer.innerHTML = `
      <div class="pbox tone-sale">
        <div class="phead">${squareArt(sq, 'big')}<div class="ptitle">${esc(seller.name)} 出售${esc(sq.name)}</div>${avatar(seller, 'lg')}</div>
        <div class="pbody">
          <div class="offer-what">
            <span class="offer-price">${money(o.price)}</span>
            <span class="offer-tags">${pr.houses ? `<em class="bk-house">连${houseText(pr.houses)}</em>` : '<em class="bk-house">空地</em>'}${pr.mortgaged ? '<em class="bk-mort">抵押中</em>' : ''}<em class="bk-rent">过路费现在 ${money(rentNow(o.square))}</em></span>
          </div>
          <p>谁要？买得起的人点自己的头像：</p>
          <div class="buyers">${buyers.map(b => `
            <button class="buyer" data-buyer="${b.id}" ${b.cash >= o.price ? '' : 'disabled'} style="--c:${esc(b.color)}">
              ${avatar(b, 'lg')}<b>${esc(b.name)}</b><span>${b.cash >= o.price ? `有 ${money(b.cash)}` : '钱不够'}</span>
            </button>`).join('')}</div>
          <button class="btn" id="offerNo">没人要，收回</button>
        </div>
      </div>`;
    layer.classList.add('show');
    sfx.pop();
    speak(`${seller.name}出售${sq.name}${pr.houses ? `，连${houseText(pr.houses).replace(/ /g, '')}` : ''}，要价 $${o.price}，谁要？`);
    const close = (v) => { stopSpeech(); layer.classList.remove('show'); setTimeout(() => resolve(v), 180); };
    layer.querySelectorAll('[data-buyer]').forEach(b => b.onclick = () => close(b.dataset.buyer));
    $('offerNo').onclick = () => close(null);
  });
}

async function sellFlow(idx) {
  if (G.busy) return;
  const price = await pickPrice(idx);
  if (price == null) return;
  if (!(await doAct({ type: 'offer', square: idx, price }))) return;
  await offerFlow();
}

async function offerFlow() {
  if (!G.state?.offer) return;
  const buyer = await showOffer();
  if (buyer) {
    const sq = SQUARES[G.state.offer.square];
    const b = player(G.state, buyer);
    if (await doAct({ type: 'acceptOffer' }, buyer)) speak(`${b.name}买下了${sq.name}`);
  } else {
    await doAct({ type: 'cancelOffer' }, G.state.offer.from);
    toast('没人买，地还是自己的');
  }
}

// 抽卡：卡片飞到屏幕中央翻开
async function showCard(e, net) {
  const p = player(G.state, e.pid);
  const deckName = e.deck === 'chance' ? '机会' : '命运';
  const mood = e.mood || 'neutral';
  const face = mood === 'good' ? FACE.good : mood === 'bad' ? FACE.bad : FACE.neutral;
  const pile = document.querySelector(`.pile-${e.deck}`);
  const label = net > 0 ? `收下 ${money(net)}` : net < 0 ? `支付 ${money(-net)}` : mood === 'good' ? '太好了' : mood === 'bad' ? '唉，好吧' : '知道了';

  const layer = $('cardLayer');
  layer.innerHTML = `
    <div class="bigcard deck-${e.deck} mood-${mood}">
      <div class="bc-inner">
        <div class="bc-face bc-back"><span>${e.deck === 'chance' ? '?' : '!'}</span><b>${deckName}</b></div>
        <div class="bc-face bc-front">
          <div class="bc-head">${deckName}卡 · ${esc(p.name)} 抽到</div>
          <img class="bc-emoji" src="/avatars/${face}.webp" alt="">
          <p class="bc-text">${esc(e.text)}</p>
          ${net ? `<div class="bc-amt ${net > 0 ? 'pos' : 'neg'}">${net > 0 ? '+' : '-'}${money(Math.abs(net))}</div>` : ''}
          <button class="btn ${mood === 'good' ? 'gold' : 'primary'} big" id="cardOk">${esc(label)}</button>
        </div>
      </div>
    </div>`;
  const card = layer.querySelector('.bigcard');
  // 从牌堆的位置飞出来
  if (pile) {
    const pr = pile.getBoundingClientRect();
    const dx = pr.left + pr.width / 2 - window.innerWidth / 2;
    const dy = pr.top + pr.height / 2 - window.innerHeight / 2;
    card.style.setProperty('--from', `translate(${dx}px, ${dy}px) rotate(-38deg) scale(.32)`);
  }
  layer.classList.add('show');
  sfx.whoosh();
  await sleep(40);
  card.classList.add('in');
  await sleep(650);
  sfx.flip();
  card.classList.add('flip');
  await sleep(480);
  card.classList.add('reveal');
  if (mood === 'good') { sfx.happy(); confetti(); } else if (mood === 'bad') sfx.sad(); else sfx.neutral();
  speak(lineFor(e));
  await waitForButton($('cardOk'), e.pid);
  stopSpeech();
  card.classList.add('out');
  await sleep(320);
  layer.classList.remove('show');
  layer.innerHTML = '';
}

// 卡片带来的钱：看紧跟在卡后面的钱款事件
function cardNet(events, k, pid) {
  let net = 0;
  for (let j = k + 1; j < events.length; j++) {
    const e = events[j];
    if (e.k === 'move') continue;
    if (e.k !== 'money') break;
    if (e.from === pid) net -= e.amount;
    if (e.to === pid) net += e.amount;
  }
  return net;
}

async function playEvents(prev, events) {
  G.disp = {
    pos: Object.fromEntries(prev.players.map(p => [p.id, p.pos])),
    jail: Object.fromEntries(prev.players.map(p => [p.id, p.inJail])),
    cash: Object.fromEntries(prev.players.map(p => [p.id, p.cash])),
    alive: Object.fromEntries(prev.players.map(p => [p.id, !p.bankrupt])),
    bankOut: prev.bankOut, bankIn: prev.bankIn,
  };
  for (const e of events) { const l = lineFor(e); if (l) prefetchSpeech(l); }
  const after = [];
  let bankruptInfo = null, tradeInfo = null;
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (PARTY) P.eventIndex = k;
    switch (e.k) {
      case 'dice':
        G.dice = e.d;
        sfx.dice();
        setDice(e.d, true);
        await sleep(1000);
        if (e.d[0] === e.d[1]) { toast('双数！'); sfx.neutral(); }
        break;
      case 'move':
        if (G.disp.jail[e.pid]) G.disp.jail[e.pid] = false;
        await walk(e);
        break;
      case 'jail': await goJail(e); break;
      case 'free':
        G.disp.jail[e.pid] = false;
        sfx.happy();
        toast(`${player(G.state, e.pid).name} 出狱了`);
        break;
      case 'charge': await charge(e); break;
      case 'money':
        if (e.why === '经过起点工资') { toast(`经过起点，${player(G.state, e.to).name} 领工资 ${money(GO_SALARY)}`); }
        await flyMoney(e);
        if (tradeInfo) { await flyPropTo(tradeInfo.square, player(G.state, tradeInfo.to)); tradeInfo = null; }
        break;
      case 'trade': tradeInfo = e; break;
      case 'card': await showCard(e, cardNet(events, k, e.pid)); break;
      case 'buy': sfx.stamp(); after.push(() => stamp(e.square)); break;
      case 'prop':
        if (e.type === 'build') sfx.build();
        after.push(() => stamp(e.square, e.type));
        break;
      case 'bankruptcy': await bankruptcyPrompt(e); bankruptInfo = e; break;
      case 'bankrupt':
        if (bankruptInfo?.pid === e.pid) await transferProps(bankruptInfo);
        bankruptInfo = null;
        G.disp.alive[e.pid] = false;
        placeTokens(true);
        await sleep(500);
        break;
      case 'turn': after.push(() => turnBanner(e.pid)); break;
    }
  }
  G.disp = null;
  return after;
}

function stamp(i, type = 'buy') {
  const el = cellEls[i];
  const cls = type === 'build' ? 'pop' : 'stamp';
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
}

function turnBanner(pid) {
  const p = player(G.state, pid);
  const b = $('banner');
  b.style.setProperty('--c', p.color);
  b.innerHTML = `${avatar(p, 'lg')}
    <div><b>轮到 ${esc(p.name)}</b><div class="small">第 ${G.state.round} 轮</div></div>
    ${G.viewer !== pid && !PARTY ? `<button class="btn gold" data-do="view" data-pid="${pid}">切换到 ${esc(p.name)}</button>` : ''}`;
  b.classList.toggle('big', PARTY);
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  sfx.turn();
  clearTimeout(turnBanner.t);
  turnBanner.t = setTimeout(() => b.classList.remove('show'), 3200);
}

// ---------- 动作 ----------

async function doAct(action, pid = G.viewer) {
  if (G.busy || !G.state) return false;
  const prev = structuredClone(G.state);
  try {
    act(G.state, pid, action, ctx());
  } catch (e) {
    toast(e.message);
    return false;
  }
  save();  // Refreshing mid-animation restores the action the engine already committed.
  G.busy = true;
  document.body.classList.add('busy');
  renderActions();
  const after = await playEvents(prev, G.state.events);
  G.busy = false;
  document.body.classList.remove('busy');
  // 破产出局的人不能再操作，直接切到下一位
  if (player(G.state, G.viewer).bankrupt && G.state.status === 'playing') G.viewer = current(G.state).id;
  save();
  render();
  after.forEach(f => f());
  if (G.state.status === 'ended') setTimeout(showResult, 600);
  return true;
}

// ---------- 渲染 ----------

function render() {
  renderOfferCard();
  updateCells();
  renderTabs();
  renderClock();
  renderToggles();
  renderActions();
  renderBank();
  renderDeed();
  renderLog();
  placeTokens(false);
}

function renderToggles() {
  const pf = getPrefs();
  $('toggles').innerHTML = `
    <button class="tgl ${pf.sound ? 'on' : ''}" data-do="toggle" data-k="sound" title="音效">${pf.sound ? ICON.soundOn : ICON.soundOff}<span>音效</span></button>
    <button class="tgl ${pf.voice ? 'on' : ''}" data-do="toggle" data-k="voice" title="语音播报">${ICON.voice}<span>语音</span></button>`;
}

function renderTabs() {
  const s = G.state;
  if (!s) { $('tabs').innerHTML = ''; return; }
  const cur = s.status === 'playing' ? current(s).id : null;
  $('tabs').innerHTML = s.players.map(p => {
    const cash = G.disp ? G.disp.cash[p.id] : p.cash;
    // 聚会模式：手机在不在线；掉线的点一下出二维码，扫了回到这个座位
    const seat = PARTY && P.room?.seats.find(x => x.id === p.id);
    const off = seat && !seat.online && !p.bankrupt;
    const recover = off && P.room.hostId === P.me;
    return `
      <button class="ptab ${G.viewer === p.id ? 'me' : ''} ${cur === p.id ? 'turn' : ''} ${p.bankrupt ? 'out' : ''} ${off ? 'offline' : ''}" data-do="${recover ? 'rejoin' : 'view'}" data-pid="${p.id}" style="--c:${esc(p.color)}">
        ${seat ? `<i class="pt-online ${off ? 'off' : ''}">${off ? (recover ? '找回座位' : '掉线') : ''}</i>` : ''}
        ${avatar(p)}
        <span class="pt-main"><span class="pt-name">${esc(p.name)}${cur === p.id ? '<i class="dot"></i>' : ''}</span><span class="pt-cash">${p.bankrupt ? '破产' : money(cash)}</span></span>
        ${p.inJail && !p.bankrupt ? '<span class="pt-flag">狱</span>' : ''}
      </button>`;
  }).join('');
}

function renderClock() {
  const s = G.state;
  if (!s) { $('clock').innerHTML = ''; return; }
  if (s.status !== 'playing') { $('clock').innerHTML = '<span class="cl-label">对局结束</span>'; return; }
  const now = PARTY && P.room?.paused ? P.room.paused : Date.now();
  const left = Math.max(0, s.endsAt - now);
  const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
  $('clock').innerHTML = left > 0
    ? `<span class="cl-time ${left < 5 * 60000 ? 'low' : ''}">${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}</span><span class="cl-label">第 ${esc(s.round)} 轮</span>`
    : `<span class="cl-time low">00:00</span><span class="cl-label">时间到 · 本轮走完结算</span>`;
}

function phaseText(s, cur) {
  switch (s.phase) {
    case 'roll':
      if (cur.inJail) return `在监狱里（第 ${cur.jailTurns + 1} 回合）：交 ${money(JAIL_FINE)}、用出狱卡，或者掷出双数出狱`;
      return s.rollAgain ? '掷出双数，再掷一次！' : '掷骰子出发';
    case 'buy': return '这块地还没有主人';
    case 'manage': return '可以去右边银行办贷款，然后结束回合';
    case 'debt': return `钱不够，欠 ${money(totalOwed(cur))}：去右边银行卖房或抵押贷款`;
  }
  return '';
}

// 聚会模式：棋盘中间一张大状态卡，谁在哪、在手机上做什么，忘了操作的人一眼就能被提醒
function statusCard(s, cur) {
  const sq = SQUARES[cur.pos];
  const where = `<div class="pc-where">${squareArt(sq, 'big')}<span>${cur.inJail ? '在监狱里' : `停在 <b>${esc(sq.name)}</b>`}</span></div>`;
  let what = '', sub = '', art = where;
  const stopSq = s.stop?.square;
  const canBuild = stopSq != null && legalActions(s, cur.id).some(a => a.type === 'build' && a.square === stopSq);
  if (P.room?.paused) what = '已暂停';
  else if (s.phase === 'roll') {
    if (cur.inJail) { what = '正在决定怎么出狱'; sub = `第 ${cur.jailTurns + 1} 回合 · 交 ${money(JAIL_FINE)}、用出狱卡，或者掷双数`; }
    else what = s.rollAgain ? '掷出双数，再掷一次！' : '正在掷骰子';
  } else if (s.phase === 'buy') {
    const b = SQUARES[s.pending.square];
    art = `<div class="pc-where">${squareArt(b, 'big')}<span>停在 <b>${esc(b.name)}</b> · 地价 ${money(b.price)}</span></div>`;
    what = b.type === 'country' ? '正在决定买不买、盖几栋' : '正在决定买不买';
    sub = `手里有 ${money(cur.cash)}`;
  } else if (s.phase === 'manage' && canBuild) {
    what = `还能盖 ${BUILD_PER_STOP - s.stop.built} 栋，正在决定`;
    sub = `每栋 ${money(GROUPS[SQUARES[stopSq].group].house)} · 手里有 ${money(cur.cash)}`;
  } else if (s.phase === 'manage') {
    if (P.room?.autoEnd?.pid === cur.id) { what = `<b id="pcLeft">${Math.max(1, Math.ceil((P.autoEndAt - performance.now()) / 1000))}</b> 秒后自动结束回合`; }
    else if (s.offer?.from === cur.id) what = '正在出售地，等人抢购';
    else { what = '正在办理贷款、卖房'; sub = '办完后点「结束回合」'; }
  } else if (s.phase === 'debt') { what = `欠 ${money(totalOwed(cur))}，正在凑钱`; sub = '卖房、抵押贷款，或者宣告破产'; }
  return `<div class="pcard" style="--c:${esc(cur.color)}">
    <div class="pc-who">${avatar(cur, 'xl')}<div><b>${esc(cur.name)}</b><span>的回合 · 第 ${esc(s.round)} 轮</span></div></div>
    ${art}<div class="pc-what">${what}</div>${sub ? `<div class="pc-sub">${sub}</div>` : ''}</div>`;
}

function renderActions() {
  const s = G.state;
  const info = $('turnInfo'), box = $('actions');
  if (!s || s.status !== 'playing') { info.innerHTML = ''; box.innerHTML = ''; return; }
  const cur = current(s);
  info.innerHTML = `${avatar(cur)}<b>${esc(cur.name)} 的回合</b>`;
  if (G.busy) { box.innerHTML = ''; return; }
  // 有地在卖时，中间让给出售卡
  if (PARTY) { box.innerHTML = s.offer ? '' : statusCard(s, cur); return; }
  if (G.viewer !== cur.id) {
    box.innerHTML = `<p class="hint">你现在是 ${esc(player(s, G.viewer).name)}，还没轮到你</p>
      <button class="btn gold big" data-do="view" data-pid="${cur.id}">切换到 ${esc(cur.name)}</button>`;
    return;
  }
  const acts = legalActions(s, cur.id);
  const has = (t) => acts.some(a => a.type === t);
  let html = `<p class="hint">${phaseText(s, cur)}</p>`;
  // 刷新页面时如果正好有地在出售，给个按钮把出售框打开
  if (s.offer) {
    box.innerHTML = `<p class="hint">${esc(cur.name)} 正在出售${esc(SQUARES[s.offer.square].name)}，要价 ${money(s.offer.price)}</p><button class="btn gold big" data-do="offerOpen">看看谁要</button>`;
    return;
  }
  if (s.phase === 'buy') {
    const sq = SQUARES[s.pending.square];
    html += `<div class="mini-deed">${deedHead(sq)}<div class="md-row"><span>地价</span><b>${money(sq.price)}</b></div><div class="md-row"><span>你有</span><b>${money(cur.cash)}</b></div></div>`;
  }
  const b = [];
  if (has('roll')) b.push(`<button class="btn primary big" data-act="roll">${cur.inJail ? '掷骰子碰运气' : '掷骰子'}</button>`);
  if (has('payJail')) b.push(`<button class="btn" data-act="payJail">交 ${money(JAIL_FINE)} 出狱</button>`);
  if (has('useCard')) b.push(`<button class="btn" data-act="useCard">用出狱卡</button>`);
  if (s.phase === 'buy') {
    const sq = SQUARES[s.pending.square];
    const canBuy = (n) => acts.some(a => a.type === 'buy' && (a.build || 0) === n);
    b.push(`<button class="btn primary big" data-act="buy" ${canBuy(0) ? '' : 'disabled'}>买下 ${money(sq.price)}</button>`);
    if (sq.type === 'country') {
      for (let n = 1; n <= BUILD_PER_STOP; n++) {
        b.push(`<button class="btn" data-act="buy" data-build="${n}" ${canBuy(n) ? '' : 'disabled'}>买下 + 盖 ${n} 栋 ${money(sq.price + n * GROUPS[sq.group].house)}</button>`);
      }
    }
    b.push(`<button class="btn" data-act="skip">不买</button>`);
  }
  // 停在自己的国家上：可以加盖
  const stopSq = s.stop?.square;
  if (stopSq != null && acts.some(a => a.type === 'build' && a.square === stopSq)) {
    const sq = SQUARES[stopSq], pr = s.props[stopSq];
    html += `<p class="hint sub">停在自己的${esc(sq.name)}，本次还能盖 ${BUILD_PER_STOP - s.stop.built} 栋</p>`;
    b.unshift(`<button class="btn gold big" data-act="build" data-sq="${stopSq}">${pr.houses === 4 ? '升级酒店' : '加盖一栋'} ${money(GROUPS[sq.group].house)}</button>`);
  }
  if (has('payDebt')) b.push(`<button class="btn primary big" data-act="payDebt">还清 ${money(totalOwed(cur))}</button>`);
  if (has('bankrupt')) b.push(`<button class="btn danger" data-act="bankrupt" data-confirm="确定宣告破产？会直接出局。">宣告破产</button>`);
  if (has('end')) b.push(`<button class="btn primary big" data-act="end">结束回合</button>`);
  box.innerHTML = html + `<div class="btns">${b.join('')}</div>`;
}

function deedHead(sq) {
  const color = sq.group ? GROUPS[sq.group].color : '#475569';
  const art = sq.flag ? `<img class="dflag" src="/flags/${sq.flag}.svg" alt="">`
    : sq.type === 'airport' ? `<i class="dic">${ICON.airport}</i>` : sq.type === 'utility' ? `<i class="dic">${sq.util === 'electric' ? ICON.electric : ICON.water}</i>` : '';
  return `<div class="dhead" style="--g:${color}">${art}<div><div class="dname">${esc(sq.name)}</div><div class="dgroup">${sq.group ? GROUPS[sq.group].name : sq.type === 'airport' ? '国际机场' : '公用事业'}</div></div></div>`;
}

function renderBank() {
  const s = G.state;
  if (!s) { $('bank').innerHTML = ''; return; }
  const me = player(s, G.viewer);
  const isTurn = !PARTY && s.status === 'playing' && current(s).id === me.id && !G.busy;
  const acts = isTurn ? legalActions(s, me.id) : [];
  const can = (type, i) => acts.some(a => a.type === type && a.square === i);
  const mine = Object.entries(s.props).filter(([, pr]) => pr.owner === me.id).map(([i, pr]) => [+i, pr]).sort((a, b) => a[0] - b[0]);

  const rows = mine.map(([i, pr]) => {
    const sq = SQUARES[i];
    const art = sq.flag ? `<img class="rflag" src="/flags/${sq.flag}.svg" alt="">` : `<i class="ric">${sq.type === 'airport' ? ICON.airport : sq.util === 'electric' ? ICON.electric : ICON.water}</i>`;
    const houses = pr.houses === 5 ? '<i class="hotel"></i>' : '<i class="house"></i>'.repeat(pr.houses);
    let btns = '';
    if (sq.type === 'country') {
      const h = GROUPS[sq.group].house;
      btns += `<button class="sbtn" data-act="build" data-sq="${i}" ${can('build', i) ? '' : 'disabled'}>${pr.houses === 4 ? '升酒店' : '盖房'} ${money(h)}</button>`;
      if (pr.houses) btns += `<button class="sbtn" data-act="sell" data-sq="${i}" ${can('sell', i) ? '' : 'disabled'}>卖房 +${money(h / 2)}</button>`;
    }
    btns += `<button class="sbtn sale" data-do="offer" data-sq="${i}" ${acts.some(a => a.type === 'offer' && a.square === i) ? '' : 'disabled'}>出售</button>`;
    btns += pr.mortgaged
      ? `<button class="sbtn warn" data-act="unmortgage" data-sq="${i}" ${can('unmortgage', i) ? '' : 'disabled'}>还贷 ${money(unmortgageCost(sq))}</button>`
      : `<button class="sbtn" data-act="mortgage" data-sq="${i}" ${can('mortgage', i) ? '' : 'disabled'}>贷款 +${money(mortgageValue(sq))}</button>`;
    return `<li class="${pr.mortgaged ? 'mort' : ''}" data-do="select" data-i="${i}">
      <span class="rgroup" style="--g:${sq.group ? GROUPS[sq.group].color : '#94a3b8'}"></span>${art}
      <span class="rname">${esc(sq.name)}${pr.mortgaged ? '<em>抵押中</em>' : ''}<span class="rh">${houses}</span></span>
      <span class="rbtns">${btns}</span></li>`;
  }).join('');

  $('bank').innerHTML = `
    <div class="bank-head">
      <div class="bank-logo">${ICON.bank}</div>
      <div class="bank-title"><b>环球银行</b><span>工资 · 买地 · 盖房 · 贷款 · 税费</span></div>
      <div class="vault" id="vault"><img src="/avatars/1f4b0.webp" alt=""></div>
    </div>
    <div class="bank-stats" id="bankStats"></div>
    <div class="svc">
      <div class="svc-head">
        ${avatar(me, 'sm')}
        <b>${esc(me.name)} 的账户</b>
        <span class="svc-cash">${money(me.cash)}${me.owed.length ? `<em>欠 ${money(totalOwed(me))}</em>` : ''}</span>
      </div>
      <div class="svc-note">只能在停留的国家上盖房，每次最多 ${BUILD_PER_STOP} 栋。抵押贷款拿回地价一半；还贷要多付 10% 利息。${isTurn ? '' : `<b>${s.status === 'playing' ? '轮到你时才能办理' : ''}</b>`}</div>
      ${mine.length ? `<ul class="assets">${rows}</ul>` : '<p class="empty">还没有地产。买下地产后，可以在这里盖房、抵押贷款。</p>'}
    </div>
    <div class="feed-head">银行流水</div>
    <ol class="feed" id="feed"></ol>`;
  renderBankStats();
  renderFeed();
}

function renderBankStats() {
  const s = G.state, el = $('bankStats');
  if (!s || !el) return;
  const out = G.disp ? G.disp.bankOut : s.bankOut;
  const inn = G.disp ? G.disp.bankIn : s.bankIn;
  const cash = G.disp ? Object.values(G.disp.cash).reduce((a, b) => a + b, 0) : s.players.reduce((a, p) => a + p.cash, 0);
  el.innerHTML = `
    <div><span>已发出</span><b class="pos">${money(out)}</b></div>
    <div><span>已收回</span><b class="neg">${money(inn)}</b></div>
    <div><span>玩家现金合计</span><b>${money(cash)}</b></div>`;
}

function renderFeed() {
  const s = G.state, el = $('feed');
  if (!s || !el) return;
  const name = (id) => id ? esc(player(s, id)?.name) : '银行';
  el.innerHTML = G.feed.slice(0, 12).map(f => {
    const bankSide = !f.from ? 'out' : !f.to ? 'in' : 'p2p';
    return `<li class="${bankSide}"><span class="fw">${name(f.from)} → ${name(f.to)}</span><span class="fwhy">${esc(f.why || '')}</span><b>${money(f.amount)}</b></li>`;
  }).join('') || '<li class="empty">还没有流水</li>';
}

function renderDeed() {
  const s = G.state;
  const i = G.selected;
  if (!s || i == null) {
    $('deed').innerHTML = '<p class="muted">点棋盘上的格子，查看地契和租金。</p>';
    return;
  }
  const sq = SQUARES[i];
  const pr = s.props[i];
  const owner = pr && player(s, pr.owner);
  let body = '';
  if (sq.type === 'country') {
    const base = baseRent(sq);
    const labels = ['空地', '1 栋房', '2 栋房', '3 栋房', '4 栋房', '酒店'];
    body = `<table class="rent">${labels.map((l, k) => `<tr class="${pr && pr.houses === k ? 'hl' : ''}"><td>${l}</td><td>${money(base * HOUSE_MULT[k])}</td></tr>`).join('')}</table>
      <div class="dnote">停在这里时可以盖房，每次最多 ${BUILD_PER_STOP} 栋，每栋 ${money(GROUPS[sq.group].house)}<br>买齐「${GROUPS[sq.group].name}」后，空地租金翻倍 · 抵押可贷 ${money(mortgageValue(sq))}</div>`;
  } else if (sq.type === 'airport') {
    body = `<table class="rent">${[1, 2, 3, 4].map(n => `<tr><td>拥有 ${n} 个机场</td><td>${money(AIRPORT_RENT[n])}</td></tr>`).join('')}</table><div class="dnote">机场不能盖房 · 抵押可贷 ${money(mortgageValue(sq))}</div>`;
  } else if (sq.type === 'utility') {
    body = `<table class="rent"><tr><td>拥有 1 家公司</td><td>点数 × 4</td></tr><tr><td>拥有 2 家公司</td><td>点数 × 10</td></tr></table><div class="dnote">抵押可贷 ${money(mortgageValue(sq))}</div>`;
  } else {
    const text = { go: `每次经过或停在这里，从银行领 ${money(GO_SALARY)} 工资。`, jail: '路过只是探监。被关进来的人可以交 $50、用出狱卡，或掷出双数出狱；第 3 回合必须交 $50。坐牢期间照样收租。', parking: '休息一下，什么都不发生。', gotojail: '停在这里直接进监狱，不经过起点，不领工资。', tax: `付给银行 ${money(sq.amount ?? 0)}。`, chance: '抽一张机会卡并立即执行。', fate: '抽一张命运卡并立即执行。' }[sq.type];
    $('deed').innerHTML = `<div class="dplain"><b>${esc(sq.name)}</b><p>${text}</p></div>`;
    return;
  }
  $('deed').innerHTML = `
    <div class="deedcard">
      ${deedHead(sq)}
      <div class="dprice">地价 <b>${money(sq.price)}</b></div>
      ${body}
      <div class="downer">${owner ? `${avatar(owner, 'sm')}${esc(owner.name)} 的${pr.mortgaged ? '（已抵押）' : ''}` : '还没有主人'}</div>
    </div>`;
}

function renderLog() {
  const s = G.state;
  $('log').innerHTML = s ? s.log.slice().reverse().slice(0, 40).map(l => `<li>${esc(l.msg)}</li>`).join('') : '';
}

// ---------- 开局：选人数、选角色 ----------

function showSetup() {
  const saved = loadSaved();
  const resumable = saved?.state?.status === 'playing';
  const st = {
    count: 4,
    active: 0,
    slots: Array.from({ length: 6 }, (_, k) => ({ code: CHARS[k].code, name: CHARS[k].name, edited: false })),
  };
  const ov = $('overlay');

  const draw = () => {
    const slots = st.slots.slice(0, st.count);
    const takenBy = Object.fromEntries(slots.map((sl, k) => [sl.code, k]));
    ov.innerHTML = `
      <div class="modal setup">
        <div class="setup-top">
          <span class="globe big"></span>
          <div><h1>客厅大富翁</h1><p class="sub">一台电脑轮流玩 · ${DURATION_MIN} 分钟一局 · 每人起始资金 ${money(START_CASH)}</p></div>
        </div>
        <div class="field-label">几个人玩</div>
        <div class="chips">${[2, 3, 4, 5, 6].map(n => `<button class="chip ${n === st.count ? 'on' : ''}" data-count="${n}">${n} 人</button>`).join('')}</div>
        <div class="field-label">选角色 <span>先点上面的玩家，再点下面的角色；每人一个，不能重复</span></div>
        <div class="slots">${slots.map((sl, k) => `
          <div class="slot ${k === st.active ? 'on' : ''}" data-slot="${k}" style="--c:${PLAYER_COLORS[k]}">
            <span class="slot-no">${k + 1} 号</span>
            <img src="/avatars/${sl.code}.webp" alt="">
            <input maxlength="6" value="${esc(sl.name)}" data-name="${k}" aria-label="${k + 1} 号玩家名字">
          </div>`).join('')}</div>
        <div class="gallery">${CHARS.map(c => {
          const t = takenBy[c.code];
          return `<button class="char ${t != null ? 'taken' : ''} ${t === st.active ? 'mine' : ''}" data-char="${c.code}" ${t != null && t !== st.active ? 'disabled' : ''} style="${t != null ? `--c:${PLAYER_COLORS[t]}` : ''}">
            <img src="/avatars/${c.code}.webp" alt=""><span>${c.name}</span>${t != null ? `<em>${t + 1} 号</em>` : ''}${AVATAR_BONUS[c.code] ? `<i class="bonus">+${money(AVATAR_BONUS[c.code])}</i>` : ''}</button>`;
        }).join('')}</div>
        <div class="btns">
          ${resumable ? '<button class="btn" id="resume">继续上一局</button>' : ''}
          <button class="btn gold big" id="start">开始游戏</button>
        </div>
      </div>`;
    ov.classList.add('show');
    ov.querySelectorAll('[data-count]').forEach(b => b.onclick = () => {
      st.count = +b.dataset.count;
      st.active = Math.min(st.active, st.count - 1);
      // 人数变多时，新座位如果和别人撞角色，换一个没人用的
      const used = new Set();
      st.slots.slice(0, st.count).forEach((sl) => {
        if (used.has(sl.code)) {
          const free = CHARS.find(c => !used.has(c.code) && !st.slots.slice(0, st.count).some(x => x.code === c.code));
          sl.code = free.code;
          if (!sl.edited) sl.name = free.name;
        }
        used.add(sl.code);
      });
      sfx.pop();
      draw();
    });
    ov.querySelectorAll('[data-slot]').forEach(el => el.onclick = (e) => {
      if (e.target.tagName === 'INPUT') return;
      st.active = +el.dataset.slot;
      draw();
    });
    ov.querySelectorAll('[data-name]').forEach(inp => {
      inp.onfocus = () => { if (st.active !== +inp.dataset.name) { st.active = +inp.dataset.name; draw(); ov.querySelector(`[data-name="${st.active}"]`).focus(); } };
      inp.oninput = () => { const sl = st.slots[+inp.dataset.name]; sl.name = inp.value; sl.edited = true; };
    });
    ov.querySelectorAll('[data-char]').forEach(b => b.onclick = () => {
      const sl = st.slots[st.active];
      sl.code = b.dataset.char;
      if (!sl.edited) sl.name = charName(sl.code);
      sfx.stamp();
      if (st.active < st.count - 1) st.active++;
      draw();
    });
    $('start').onclick = () => {
      const players = st.slots.slice(0, st.count).map((sl, k) => ({ id: LETTERS[k], name: sl.name.trim() || charName(sl.code), avatar: sl.code }));
      startCountdown(players);
    };
    if (resumable) $('resume').onclick = () => { restore(saved); ov.classList.remove('show'); };
  };
  draw();
}

async function startCountdown(players) {
  newCloudGame();
  await countdown();
  await begin(createGame(players, { durationMin: DURATION_MIN, shuffleOrder: false }, ctx()));
}

async function countdown() {
  const ov = $('overlay');
  ov.classList.add('show');
  for (const t of ['3', '2', '1', '开始！']) {
    ov.innerHTML = `<div class="count ${t.length > 1 ? 'go' : ''}">${t}</div>`;
    sfx.beep(t.length > 1);
    await sleep(t.length > 1 ? 700 : 850);
  }
  ov.classList.remove('show');
  ov.innerHTML = '';
}

// 新的一局摆上棋盘；开局事件（角色奖励）播一遍
async function begin(state) {
  G.state = state;
  G.viewer = PARTY ? P.me : current(G.state).id;
  G.feed = [];
  G.selected = null;
  save();
  $('tokens').innerHTML = '';
  render();
  // 角色奖励：钱从银行飞过去
  if (G.state.events.length) {
    const prev = structuredClone(G.state);
    for (const e of G.state.events) {
      player(prev, e.to).cash -= e.amount;
      prev.bankOut -= e.amount; prev.bankNet -= e.amount;
    }
    G.busy = true;
    for (const e of G.state.events) toast(`${player(G.state, e.to).name} 的角色奖励：开局多拿 ${money(e.amount)}`);
    await playEvents(prev, G.state.events);
    G.busy = false;
    G.state.events = [];
    save();
    render();
  }
  turnBanner(current(G.state).id);

}

function restore(saved) {
  G.state = saved.state;
  G.viewer = saved.viewer || current(G.state).id;
  G.feed = saved.feed || [];
  $('tokens').innerHTML = '';
  render();
}

function showResult() {
  const s = G.state;
  if (s?.status !== 'ended') return;
  const w = player(s, s.winner);
  const ov = $('overlay');
  ov.innerHTML = `
    <div class="modal result">
      <div class="trophy" style="--c:${esc(w.color)}">${w.avatar ? `<img src="/avatars/${encodeURIComponent(w.avatar)}.webp" alt="">` : esc([...w.name][0])}</div>
      <h1>${esc(w.name)} 获胜！</h1>
      <p class="sub">${s.endReason === 'time' ? '时间到，按净资产排名' : s.endReason === 'host' ? '主持人结束，按净资产排名' : '其他人都破产了'} · 共 ${esc(s.round)} 轮</p>
      <ol class="rank">${s.ranking.map(r => `<li>${avatar(player(s, r.id), 'lg')}<div class="rk-main"><span class="rk-name">${esc(r.name)}</span><small class="rk-detail">${r.bankrupt ? '已破产' : r.cash == null ? '' : `现金 ${money(r.cash)} · 地 ${esc(r.count)} 块 ${money(r.land)} · 房子 ${money(r.houses)}`}</small></div><b>${r.bankrupt ? '破产' : money(r.worth)}</b></li>`).join('')}</ol>
      <div class="btns"><button class="btn gold big" id="again">${PARTY && P.room.hostId !== P.me ? '查看棋盘' : '再来一局'}</button>${PARTY ? '<a class="btn" href="/">返回首页</a>' : ''}</div>
    </div>`;
  ov.classList.add('show');
  sfx.win();
  confetti(120);
  speak(`${w.name}获胜`);
  $('again').onclick = PARTY
    ? () => { if (P.room.hostId === P.me) P.send({ t: 'again' }); else ov.classList.remove('show'); }
    : () => { clearSaved(); G.state = null; render(); showSetup(); };
}

// 房间只有一个连接，由 phone.js 负责。动画播放期间仍然接收服务器的确认和新快照。
const P = { room: null, me: null, send: null, running: false, pending: null, prompt: null, eventIndex: null, presented: null, resultFor: null };
setInterval(() => {
  const el = $('pcLeft');
  if (el) el.textContent = Math.max(1, Math.ceil((P.autoEndAt - performance.now()) / 1000));
}, 250);

export function detachRoomBoard() {
  if (P.prompt) { P.prompt.resolve(); P.prompt = null; }
}

function presentIfReady() {
  const room = P.room, g = room?.game;
  if (!g || P.presented?.seq !== g.seq || P.presented.startedAt !== g.startedAt) return;
  if (room.showing && !room.paused && room.presenterId === P.me && !P.presented.sent) {
    P.send({ t: 'played', seq: g.seq });
    P.presented.sent = true;
  }
  if (g.status === 'ended' && !room.showing && P.resultFor !== g.startedAt) {
    P.resultFor = g.startedAt;
    showResult();
  }
}

export function updateRoomBoard(room, me, send, { started = false, reconnect = false } = {}) {
  P.me = me;
  P.send = send;
  P.room = room;
  if (room.paused && P.presented) P.presented.sent = false;
  P.autoEndAt = room.autoEnd ? performance.now() + room.autoEnd.left : 0;
  if (P.prompt && room.waitingFor?.id !== P.prompt.id) detachRoomBoard();
  document.body.classList.toggle('room-lobby', !room.game);
  document.body.classList.toggle('room-paused', !!room.paused);
  if (room.game && G.state?.seq === room.game.seq && G.state.startedAt === room.game.startedAt && !reconnect) {
    renderClock();
    renderTabs();
    renderActions();
    presentIfReady();
    return;
  }
  P.pending = { room, started, reconnect };
  if (!P.running) drainParty();
}

async function drainParty() {
  P.running = true;
  try {
    while (P.pending) {
      const { room, started, reconnect } = P.pending;
      P.pending = null;
      const next = room.game;
      if (!next) {
        G.state = null;
        P.presented = null;
        P.resultFor = null;
        G.feed = [];
        G.disp = null;
        $('overlay').classList.remove('show');
        $('tokens').replaceChildren();
        render();
        continue;
      }
      const prev = G.state;
      if (!prev || reconnect || prev.startedAt !== next.startedAt || next.seq !== prev.seq + 1) {
        $('overlay').classList.remove('show');
        if (started) {
          await countdown();
          await begin(structuredClone(next));
        } else {
          restore({ state: next, viewer: P.me, feed: prev?.startedAt === next.startedAt ? G.feed : [] });
        }
        fitBoard();
      } else {
        G.state = next;
        G.viewer = P.me;
        G.busy = true;
        document.body.classList.add('busy');
        renderActions();
        try {
          const after = await playEvents(prev, next.events || []);
          render();
          after.forEach(f => f());
          offerSay(prev, next);
        } finally {
          G.disp = null;
          G.busy = false;
          document.body.classList.remove('busy');
        }
      }
      render();
      P.presented = { seq: next.seq, startedAt: next.startedAt, sent: false };
      presentIfReady();
    }
  } catch (error) {
    console.error(error);
    if (P.room?.game) restore({ state: P.room.game, viewer: P.me });
  } finally {
    P.running = false;
  }
}

// 有地挂牌时棋盘中间常驻一张出售卡（聚会模式不能用要人点的弹框）
function renderOfferCard() {
  if (!PARTY) return;
  let el = $('offerCard');
  const s = G.state, o = s?.status === 'playing' ? s.offer : null;
  if (!o) { el?.classList.remove('show'); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'offerCard';
    el.className = 'offer-card';
    $('center').append(el);
  }
  const seller = player(s, o.from), sq = SQUARES[o.square], pr = s.props[o.square];
  const buyers = s.players.filter(p => p.id !== seller.id && !p.bankrupt);
  const cash = (p) => G.disp ? G.disp.cash[p.id] : p.cash;
  el.innerHTML = `
    <div class="oc-head">${avatar(seller, 'sm')}<b>${esc(seller.name)} 出售</b></div>
    <div class="oc-what">${squareArt(sq, 'big')}<div><div class="oc-name">${esc(sq.name)}</div>
      <div class="offer-tags">${pr.houses ? `<em class="bk-house">连${houseText(pr.houses)}</em>` : '<em class="bk-house">空地</em>'}${pr.mortgaged ? '<em class="bk-mort">抵押中</em>' : ''}<em class="bk-rent">过路费 ${money(rentNow(o.square))}</em></div></div></div>
    <div class="oc-price">${money(o.price)}</div>
    <div class="oc-buyers">${buyers.map(b => `<span class="${cash(b) >= o.price ? 'can' : ''}">${avatar(b, 'sm')}<i>${cash(b) >= o.price ? '买得起' : '钱不够'}</i></span>`).join('')}</div>
    <div class="oc-hint">在你的操作区点「抢购」，谁先点谁买</div>`;
  el.classList.add('show');
}

// 挂牌、成交、收回的播报
function offerSay(prev, next) {
  const was = prev.offer, now = next.offer;
  if (now && now.square !== was?.square) {
    const seller = player(next, now.from), sq = SQUARES[now.square], pr = next.props[now.square];
    sfx.pop();
    speak(`${seller.name}出售${sq.name}${pr.houses ? `，连${houseText(pr.houses).replace(/ /g, '')}` : ''}，要价 $${now.price}，谁要？`);
  }
  if (was && now?.square !== was.square) {
    const sq = SQUARES[was.square], owner = next.props[was.square]?.owner;
    if (owner && owner !== was.from) speak(`${player(next, owner).name}买下了${sq.name}`);
    else toast(`没人买，${sq.name}还是 ${player(next, was.from).name} 的`);
  }
}

// ---------- 事件 ----------

document.addEventListener('pointerdown', unlock, { capture: true });
document.addEventListener('keydown', unlock, { capture: true });

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-do],[data-act],.cell');
  if (!el || el.disabled) return;
  if (el.closest('#overlay, .room-ui')) return;
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
  if (PARTY && (el.dataset.act || ['view', 'offer', 'offerOpen'].includes(el.dataset.do))) return;
  if (el.dataset.act) {
    e.stopPropagation();
    const action = { type: el.dataset.act };
    if (el.dataset.sq) action.square = +el.dataset.sq;
    if (el.dataset.build) action.build = +el.dataset.build;
    return doAct(action);
  }
  if (el.dataset.do === 'toggle') {
    const k = el.dataset.k;
    setPref(k, !getPrefs()[k]);
    renderToggles();
    if (k === 'sound' && getPrefs().sound) sfx.coinIn();
    if (k === 'voice' && getPrefs().voice) speak('语音播报已打开');
    return;
  }
  if (el.dataset.do === 'rejoin') return P.send({ t: 'claimLink', pid: el.dataset.pid });
  if (el.dataset.do === 'offer') { e.stopPropagation(); return sellFlow(+el.dataset.sq); }
  if (el.dataset.do === 'offerOpen') return offerFlow();
  if (el.classList.contains('cell') || el.dataset.do === 'select') {
    const i = +el.dataset.i;
    G.selected = G.selected === i ? null : i;
    updateCells();
    renderDeed();
    return;
  }
  if (el.dataset.do === 'view') {
    if (G.busy) return;
    G.viewer = el.dataset.pid;
    $('banner').classList.remove('show');
    save();
    render();
  }
});

$('newGame').onclick = () => {
  if (G.state?.status === 'playing' && !confirm('放弃当前对局，开新的一局？')) return;
  clearSaved();
  G.state = null;
  render();
  showSetup();
};

window.addEventListener('resize', fitBoard);
setInterval(renderClock, 500);

buildBoard();
buildDice();
if (PARTY) {
  $('newGame').hidden = true;
} else {
  const cloud = document.createElement('button');
  cloud.className = 'ghost';
  cloud.textContent = '云存档';
  cloud.onclick = showCloudSave;
  $('newGame').before(cloud);
  const saved = loadSaved();
  function recover(snapshot) {
    const previous = { state: G.state, viewer: G.viewer, feed: G.feed };
    try {
      restore(snapshot);
      $('overlay').classList.remove('show');
      if (snapshot.state.status === 'ended') showResult();
      try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch {}
    } catch {
      Object.assign(G, previous);
      $('tokens').replaceChildren();
      if (previous.state) render();
      else showSetup();
      toast('存档无法读取，请检查恢复链接或开始新局');
      return false;
    }
    return true;
  }
  if (saved?.state?.status === 'playing') recover(saved);
  else showSetup();
  startCloudSave({ restore: snapshot => {
    if (!recover(snapshot)) throw new Error('无效存档');
  } });
}
fitBoard();
render();
