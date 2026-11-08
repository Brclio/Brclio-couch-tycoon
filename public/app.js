// 前端：只发动作、只负责显示。规则全在服务器。
import { boardPosition } from './board-position.js';
import { SQUARES, GROUPS, LONG_SIDE, SHORT_SIDE, BUILD_PER_STOP, GO_SALARY, baseRent, HOUSE_MULT, AIRPORT_RENT, mortgageValue, unmortgageCost } from '/shared/board.js';
import { legalActions, current, netWorth, totalOwed, saleCost } from '/shared/engine.js';

const $app = document.getElementById('app');
const $me = document.getElementById('me');
const $toast = document.getElementById('toast');

const S = {
  token: load('mf_token'),
  user: null,
  lobby: [],
  table: null,
  selected: null,      // 选中的格子
  ws: null,
  pendingCode: null,
  lastCardSeq: null,
};

const m = location.pathname.match(/^\/t\/([A-Za-z0-9]{6})/);
if (m) { S.pendingCode = m[1].toUpperCase(); history.replaceState(null, '', '/online'); }

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2600);
}

// ---------- 连接 ----------

function connect() {
  if (!S.token) return render();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = S.ws = new WebSocket(`${proto}://${location.host}/ws?token=${S.token}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'auth') {
      if (!msg.ok) { S.token = null; store('mf_token', null); return render(); }
      S.user = msg.user;
    } else if (msg.t === 'lobby') {
      S.lobby = msg.tables;
    } else if (msg.t === 'table') {
      S.table = msg.table;
      if (!S.table && S.pendingCode) { send({ t: 'join', code: S.pendingCode }); S.pendingCode = null; }
    } else if (msg.t === 'error') {
      return toast(msg.msg);
    }
    render();
  };
  ws.onclose = () => {
    if (S.ws !== ws || !S.token) return;
    setTimeout(connect, 1500);
  };
}

const send = (msg) => S.ws?.readyState === 1 ? S.ws.send(JSON.stringify(msg)) : toast('正在重新连接…');
const gameAct = action => send({ t: 'act', action, seq: S.table?.game?.seq });

// ---------- 渲染 ----------

function render() {
  $me.innerHTML = S.user
    ? `<span class="avatar sm" style="--c:${avatarColor(S.user.name)}">${esc([...S.user.name][0])}</span><span class="me-name">${esc(S.user.name)}</span><button class="link" data-do="logout">退出</button>`
    : '';
  if (!S.token) return renderLogin();
  if (!S.user) { $app.innerHTML = '<p class="loading">连接中…</p>'; return; }
  if (!S.table) return renderLobby();
  if (S.table.status === 'waiting') return renderWaiting();
  renderGame();
}

function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return `hsl(${h} 55% 52%)`;
}

function renderLogin() {
  $app.innerHTML = `
    <section class="card login">
      <h1>客厅大富翁</h1>
      <p class="sub">掷骰子绕地球跑圈，买下国家盖房子，别人踩到就交过路费。</p>
      ${S.pendingCode ? `<p class="note">登录后自动加入邀请码 <b>${S.pendingCode}</b> 的桌子</p>` : ''}
      <form id="loginForm">
        <label>昵称<input name="name" maxlength="12" autocomplete="username" required></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="row">
          <button class="btn primary" data-mode="login">登录</button>
          <button class="btn" data-mode="register">注册新账号</button>
        </div>
      </form>
    </section>`;
  const form = document.getElementById('loginForm');
  form.onsubmit = (e) => e.preventDefault();
  form.querySelectorAll('[data-mode]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    try {
      const response = await fetch(`/api/${b.dataset.mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const r = await response.json();
      if (!response.ok || !r.token) return toast(r.error || '登录失败，请重试');
      S.token = r.token; S.user = null;
      store('mf_token', r.token);
      connect();
      render();
    } catch { toast('网络连接失败，请重试'); }
    finally { for (const button of form.querySelectorAll('button')) button.disabled = false; }
  });
}

const DUR = { 0: '不限时', 30: '30 分钟', 60: '60 分钟' };

function renderLobby() {
  const list = S.lobby.length ? S.lobby.map(t => `
    <li class="tbl">
      <div class="tbl-main">
        <div class="tbl-name">${t.locked ? '<span class="lock" title="上锁"></span>' : ''}${esc(t.name)}</div>
        <div class="tbl-meta">房主 ${esc(t.host)} · ${DUR[t.duration]}</div>
      </div>
      <div class="seats-pill">${t.count}/${t.max}</div>
      <button class="btn ${t.locked ? '' : 'primary'}" data-do="joinTable" data-id="${t.id}" data-locked="${t.locked}" ${t.count >= t.max ? 'disabled' : ''}>
        ${t.count >= t.max ? '已满' : t.locked ? '输码加入' : '加入'}
      </button>
    </li>`).join('') : '<li class="empty">现在还没有桌子，建一张吧</li>';

  $app.innerHTML = `
    <div class="lobby">
      <section class="card">
        <h2>大厅</h2>
        <ul class="tables">${list}</ul>
      </section>
      <div class="lobby-side">
        <section class="card">
          <h2>用邀请码加入</h2>
          <form class="row" id="codeForm">
            <input name="code" maxlength="6" placeholder="6 位邀请码" class="code-input" autocomplete="off">
            <button class="btn primary">加入</button>
          </form>
        </section>
        <section class="card">
          <h2>建一张桌子</h2>
          <form id="createForm" class="stack">
            <label>桌名<input name="name" maxlength="16" placeholder="${esc(S.user.name)}的桌子"></label>
            <div class="row">
              <label>人数上限
                <select name="max">${[2, 3, 4, 5, 6].map(n => `<option ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}</select>
              </label>
              <label>对局时长
                <select name="duration"><option value="30">30 分钟</option><option value="60" selected>60 分钟</option><option value="0">不限时</option></select>
              </label>
            </div>
            <label class="check"><input type="checkbox" name="locked"> 上锁（只有拿到邀请码的人能进）</label>
            <button class="btn primary">建桌</button>
          </form>
        </section>
      </div>
    </div>`;

  document.getElementById('codeForm').onsubmit = (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code').trim();
    if (code.length !== 6) return toast('邀请码是 6 位');
    send({ t: 'join', code });
  };
  document.getElementById('createForm').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    send({ t: 'create', name: f.get('name'), max: +f.get('max'), duration: +f.get('duration'), locked: f.get('locked') === 'on' });
  };
}

function renderWaiting() {
  const t = S.table;
  const isHost = t.hostId === S.user.id;
  const mine = t.seats.find(s => s.id === S.user.id);
  const others = t.seats.filter(s => s.id !== t.hostId);
  const canStart = t.seats.length >= 2 && others.every(s => s.ready);
  const link = `${location.origin}/t/${t.code}`;
  const empty = Array.from({ length: t.max - t.seats.length }, () => '<li class="seat empty">等待加入…</li>').join('');

  $app.innerHTML = `
    <section class="card waiting">
      <div class="wait-head">
        <h2>${t.locked ? '<span class="lock"></span>' : ''}${esc(t.name)}</h2>
        <span class="muted">${t.seats.length}/${t.max} 人 · ${DUR[t.duration]}</span>
      </div>
      <div class="invite">
        <div>
          <div class="muted small">邀请码</div>
          <div class="code">${t.code}</div>
        </div>
        <div class="invite-btns">
          <button class="btn" data-do="copy" data-text="${t.code}">复制邀请码</button>
          <button class="btn" data-do="copy" data-text="${link}">复制邀请链接</button>
        </div>
      </div>
      <ul class="seat-list">
        ${t.seats.map(s => `
          <li class="seat">
            <span class="avatar" style="--c:${avatarColor(s.name)}">${esc([...s.name][0])}</span>
            <span class="seat-name">${esc(s.name)}${s.id === S.user.id ? '（我）' : ''}</span>
            ${s.id === t.hostId ? '<span class="tag">房主</span>' : s.ready ? '<span class="tag ok">已准备</span>' : '<span class="tag">未准备</span>'}
            ${s.online ? '' : '<span class="tag warn">离线</span>'}
          </li>`).join('')}
        ${empty}
      </ul>
      <div class="row wrap">
        ${isHost ? `
          <label class="check"><input type="checkbox" data-do="lock" ${t.locked ? 'checked' : ''}> 上锁</label>
          <button class="btn primary" data-do="start" ${canStart ? '' : 'disabled'}>开始游戏</button>
          <span class="muted small">${t.seats.length < 2 ? '至少 2 人才能开始' : canStart ? '' : '等其他人准备'}</span>
        ` : `
          <button class="btn primary" data-do="ready" data-v="${!mine.ready}">${mine.ready ? '取消准备' : '准备'}</button>
        `}
        <span class="spacer"></span>
        <button class="btn" data-do="leave">离开</button>
      </div>
    </section>`;
}

// ---------- 棋盘 ----------

function side(i) {
  const [row, col] = boardPosition(i);
  const v = row === 1 || row === SHORT_SIDE + 2;
  const h = col === 1 || col === LONG_SIDE + 2;
  return 'side-' + (v && h ? 'corner' : row === 1 ? 'top' : col === 1 ? 'left' : v ? 'bottom' : 'right');
}

const CORNER_ICON = {
  go: '<svg viewBox="0 0 24 24"><path d="M20 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  jail: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 4v16M15 4v16" stroke="currentColor" stroke-width="2"/></svg>',
  parking: '<svg viewBox="0 0 24 24"><path d="M8 20V4h5a4 4 0 0 1 0 8H8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gotojail: '<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const TYPE_ICON = {
  airport: '<svg viewBox="0 0 24 24"><path d="M21 15v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5.5z" fill="currentColor"/></svg>',
  utility: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>',
  chance: '<b>?</b>', fate: '<b>!</b>',
  tax: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

function renderCell(g, sq) {
  const [r, c] = boardPosition(sq.index);
  const pr = g.props[sq.index];
  const owner = pr && g.players.find(p => p.id === pr.owner);
  const tokens = g.players.filter(p => !p.bankrupt && p.pos === sq.index)
    .map(p => `<span class="token ${p.id === current(g).id ? 'cur' : ''}" style="--c:${p.color}" title="${esc(p.name)}">${esc([...p.name][0])}</span>`).join('');
  const houses = pr?.houses
    ? (pr.houses === 5 ? '<span class="hotel"></span>' : '<span class="house"></span>'.repeat(pr.houses))
    : '';
  const band = sq.group ? `<div class="band" style="--g:${GROUPS[sq.group].color}">${houses}</div>` : '';
  const icon = sq.flag ? `<img class="tile-flag" src="/flags/${sq.flag}.svg" alt="">` : CORNER_ICON[sq.type] || TYPE_ICON[sq.type] || '';
  const price = sq.price ? `<div class="price">$${sq.price}</div>` : sq.type === 'tax' ? `<div class="price">$${sq.amount}</div>` : '';
  return `
    <button class="cell ${side(sq.index)} t-${sq.type} ${pr?.mortgaged ? 'mortgaged' : ''} ${S.selected === sq.index ? 'sel' : ''} ${owner ? 'owned' : ''}"
      style="grid-area:${r}/${c};${owner ? `--o:${owner.color}` : ''}" data-do="select" data-i="${sq.index}">
      ${band}
      <div class="cell-body">
        ${icon ? `<div class="icon">${icon}</div>` : ''}
        <div class="name">${esc(sq.name)}</div>
        ${price}
      </div>
      ${owner ? '<span class="owner-mark"></span>' : ''}
      <div class="tokens">${tokens}</div>
    </button>`;
}

const DICE_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const die = (n) => `<span class="die">${Array.from({ length: 9 }, (_, k) => `<i class="${DICE_PIPS[n].includes(k) ? 'on' : ''}"></i>`).join('')}</span>`;

function phaseText(g, me, cur) {
  const who = cur.id === me?.id ? '你' : cur.name;
  if (g.status === 'ended') return '对局结束';
  switch (g.phase) {
    case 'roll': return cur.inJail ? `${who}在监狱里：交罚金、用出狱卡或掷双数` : (g.rollAgain ? `${who}掷出双数，再掷一次` : `轮到${who}掷骰`);
    case 'buy': return `${who}要不要买 ${SQUARES[g.pending.square].name}？`;
    case 'manage': return `${who}可以盖房、抵押，然后结束回合`;
    case 'debt': return `${who}欠了 $${totalOwed(cur)}，先卖房或抵押凑钱`;
  }
  return '';
}

function actionButtons(g, me) {
  if (!me || me.bankrupt) return '';
  const acts = legalActions(g, me.id);
  const has = (t) => acts.some(a => a.type === t);
  const b = [];
  if (has('roll')) b.push(`<button class="btn primary big" data-act="roll">掷骰子</button>`);
  if (has('payJail')) b.push(`<button class="btn" data-act="payJail">交 $50 出狱</button>`);
  if (has('useCard')) b.push(`<button class="btn" data-act="useCard">用出狱卡</button>`);
  if (g.phase === 'buy' && current(g).id === me.id) {
    const sq = SQUARES[g.pending.square];
    b.push(`<button class="btn primary big" data-act="buy" ${has('buy') ? '' : 'disabled'}>买下 $${sq.price}</button>`);
    if (sq.type === 'country') {
      for (let n = 1; n <= BUILD_PER_STOP; n++) {
        const ok = acts.some(a => a.type === 'buy' && a.build === n);
        b.push(`<button class="btn" data-act="buy" data-build="${n}" ${ok ? '' : 'disabled'}>买下 + 盖 ${n} 栋 · $${sq.price + n * GROUPS[sq.group].house}</button>`);
      }
    }
    b.push(`<button class="btn" data-act="skip">不买</button>`);
  }
  if (has('payDebt')) b.push(`<button class="btn primary big" data-act="payDebt">还清 $${totalOwed(me)}</button>`);
  if (has('bankrupt')) b.push(`<button class="btn danger" data-act="bankrupt" data-confirm="确定宣告破产？你会出局。">宣告破产</button>`);
  if (has('end')) b.push(`<button class="btn primary big" data-act="end">结束回合</button>`);
  return b.join('');
}

function squareDetail(g, me) {
  const i = S.selected ?? (g.phase === 'buy' ? g.pending.square : null);
  if (i == null) return '<p class="muted small">点棋盘上的格子看详情、盖房或抵押。</p>';
  const sq = SQUARES[i];
  const pr = g.props[i];
  const owner = pr && g.players.find(p => p.id === pr.owner);
  let rows = '';
  if (sq.type === 'country') {
    const base = baseRent(sq);
    const labels = ['空地', '1 栋房', '2 栋房', '3 栋房', '4 栋房', '酒店'];
    rows = labels.map((l, k) => `<tr class="${pr && pr.houses === k ? 'hl' : ''}"><td>${l}</td><td>$${base * HOUSE_MULT[k]}</td></tr>`).join('')
      + `<tr><td colspan="2" class="muted small">买齐${GROUPS[sq.group].name}后空地租金翻倍 · 每栋房 $${GROUPS[sq.group].house}</td></tr>`;
  } else if (sq.type === 'airport') {
    rows = [1, 2, 3, 4].map(n => `<tr><td>拥有 ${n} 个机场</td><td>$${AIRPORT_RENT[n]}</td></tr>`).join('');
  } else if (sq.type === 'utility') {
    rows = '<tr><td>拥有 1 个公司</td><td>点数 × 4</td></tr><tr><td>拥有 2 个公司</td><td>点数 × 10</td></tr>';
  }
  let btns = '';
  if (me && owner?.id === me.id) {
    const acts = legalActions(g, me.id).filter(a => a.square === i);
    const has = (t) => acts.some(a => a.type === t);
    if (has('offer')) btns += `<button class="btn sm" data-do="offer" data-sq="${i}">挂牌出售</button>`;
    if (sq.type === 'country') {
      const cost = GROUPS[sq.group].house;
      btns += `<button class="btn sm" data-act="build" data-sq="${i}" ${has('build') ? '' : 'disabled'}>${pr.houses === 4 ? '升级酒店' : '盖房'} $${cost}</button>`;
      btns += `<button class="btn sm" data-act="sell" data-sq="${i}" ${has('sell') ? '' : 'disabled'}>卖房 +$${cost / 2}</button>`;
    }
    btns += pr.mortgaged
      ? `<button class="btn sm" data-act="unmortgage" data-sq="${i}" ${has('unmortgage') ? '' : 'disabled'}>赎回 $${unmortgageCost(sq)}</button>`
      : `<button class="btn sm" data-act="mortgage" data-sq="${i}" ${has('mortgage') ? '' : 'disabled'}>抵押 +$${mortgageValue(sq)}</button>`;
  }
  return `
    <div class="detail">
      <div class="detail-head" style="--g:${sq.group ? GROUPS[sq.group].color : 'var(--line)'}">
        <b>${esc(sq.name)}</b>${sq.price ? `<span>$${sq.price}</span>` : ''}
      </div>
      ${sq.group ? `<div class="muted small">${GROUPS[sq.group].name}</div>` : ''}
      ${owner ? `<div class="small">主人：<span class="dot" style="--c:${owner.color}"></span>${esc(owner.name)}${pr.mortgaged ? '（已抵押）' : ''}${pr.houses ? ` · ${pr.houses === 5 ? '酒店' : `${pr.houses} 栋房`}` : ''}</div>`
        : sq.price ? '<div class="small muted">还没有主人</div>' : ''}
      ${rows ? `<table class="rent">${rows}</table>` : ''}
      ${btns ? `<div class="row wrap">${btns}</div>` : ''}
      ${!sq.price ? `<p class="small">${({ go: `经过或停在这里领 $${GO_SALARY}`, jail: '路过只是探监', parking: '休息一下，什么都不发生', gotojail: `直接进监狱，不领 $${GO_SALARY}`, tax: `付给银行 $${sq.amount}`, chance: '抽一张卡', fate: '抽一张卡' })[sq.type]}</p>` : ''}
    </div>`;
}

function renderGame() {
  const t = S.table, g = t.game;
  const me = g.players.find(p => p.id === S.user.id);
  const cur = current(g);
  const myTurn = cur.id === me?.id && g.status === 'playing';

  const players = g.order.map(k => g.players[k]).map(p => {
    const online = t.seats.find(s => s.id === p.id)?.online;
    const props = Object.entries(g.props).filter(([, pr]) => pr.owner === p.id).length;
    return `
      <li class="pl ${p.id === cur.id && g.status === 'playing' ? 'cur' : ''} ${p.bankrupt ? 'out' : ''}">
        <span class="token lg" style="--c:${p.color}">${esc([...p.name][0])}</span>
        <div class="pl-main">
          <div class="pl-name">${esc(p.name)}${p.id === me?.id ? '（我）' : ''}
            ${p.inJail ? '<span class="tag warn">坐牢</span>' : ''}
            ${p.jailCards ? '<span class="tag">出狱卡</span>' : ''}
            ${online === false && !p.bankrupt ? '<span class="tag warn">离线</span>' : ''}
            ${p.bankrupt ? '<span class="tag">破产</span>' : ''}
          </div>
          <div class="pl-meta">${props} 块地 · 净资产 $${netWorth(g, p)}</div>
        </div>
        <div class="pl-cash">$${p.cash}${p.owed.length ? `<div class="owed">欠 $${totalOwed(p)}</div>` : ''}</div>
      </li>`;
  }).join('');

  const card = g.card ? `<div class="drawn"><div class="small muted">${esc(g.players.find(p => p.id === g.card.by)?.name)} 抽到</div>${esc(g.card.text)}</div>` : '';
  const dice = g.dice ? `<div class="dice">${die(g.dice[0])}${die(g.dice[1])}</div>` : '';
  const left = Math.max(0, Math.ceil((g.deadline - Date.now()) / 1000));
  const timeLeft = g.endsAt ? Math.max(0, Math.ceil((g.endsAt - Date.now()) / 60000)) : null;

  const ended = g.status === 'ended' ? `
    <div class="overlay">
      <div class="card result">
        <h2>${g.winner === S.user.id ? '你赢了！' : `${esc(g.players.find(p => p.id === g.winner).name)} 获胜`}</h2>
        <p class="muted">${g.endReason === 'time' ? '时间到，按净资产排名' : '其他人都破产了'}</p>
        <ol class="rank">${g.ranking.map(r => `<li><span>${esc(r.name)}</span><span>${r.bankrupt ? '破产' : `$${r.worth}`}</span></li>`).join('')}</ol>
        <div class="row">
          ${t.hostId === S.user.id ? '<button class="btn primary" data-do="again">再来一局</button>' : '<span class="muted small">等房主开下一局，或者</span>'}
          <button class="btn" data-do="leave">回大厅</button>
        </div>
      </div>
    </div>` : '';

  $app.innerHTML = `
    <div class="game">
      <div class="board-wrap">
        <div class="board" style="--cols:${LONG_SIDE};--rows:${SHORT_SIDE}">
          ${SQUARES.map(sq => renderCell(g, sq)).join('')}
          <div class="center">
            <div class="center-title">客厅大富翁</div>
            ${dice}
            <div class="phase ${myTurn ? 'mine' : ''}">${esc(phaseText(g, me, cur))}</div>
            ${g.status === 'playing' ? `<div class="timer ${left <= 10 ? 'low' : ''}" id="timer">${left}s</div>` : ''}
            <div class="acts">${myTurn ? actionButtons(g, me) : ''}</div>
            ${card}
          </div>
        </div>
      </div>
      <aside class="panel">
        ${g.offer && g.status === 'playing' ? `<section class="card"><h3>${esc(g.players.find(p => p.id === g.offer.from)?.name)} 出售${esc(SQUARES[g.offer.square].name)}</h3>
          <p>要价 $${g.offer.price} · 连同建筑和抵押状态一起转让</p>
          ${g.offer.from === me?.id ? '<button class="btn" data-act="cancelOffer">收回挂牌</button>' : `<button class="btn primary" data-act="acceptOffer" data-confirm="确认以 $${g.offer.price} 抢购？" ${!me || !legalActions(g, me.id).some(a => a.type === 'acceptOffer') ? 'disabled' : ''}>抢购</button>`}</section>` : ''}
        <section class="card">
          <div class="panel-head"><h3>${esc(t.name)}</h3><span class="muted small">${timeLeft == null ? '不限时' : `剩 ${timeLeft} 分钟`}</span></div>
          <ul class="players">${players}</ul>
        </section>
        <section class="card">${squareDetail(g, me)}</section>
        <section class="card log">
          <h3>记录</h3>
          <ol>${g.log.slice().reverse().slice(0, 30).map(l => `<li>${esc(l.msg)}</li>`).join('')}</ol>
        </section>
        <div class="row">
          ${me && !me.bankrupt && g.status === 'playing' ? '<button class="btn sm danger" data-act="resign" data-confirm="确定认输并退出本局？">认输</button>' : ''}
          ${g.status === 'playing' && (!me || me.bankrupt) ? '<button class="btn sm" data-do="leave">回大厅</button>' : ''}
        </div>
      </aside>
      ${ended}
    </div>`;
}

// 倒计时只更新数字，不重画整页
setInterval(() => {
  const el = document.getElementById('timer');
  if (!el || !S.table?.game) return;
  const left = Math.max(0, Math.ceil((S.table.game.deadline - Date.now()) / 1000));
  el.textContent = `${left}s`;
  el.classList.toggle('low', left <= 10);
}, 500);

// ---------- 事件 ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-do],[data-act]');
  if (!el || el.disabled) return;
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;

  if (el.dataset.act) {
    const action = { type: el.dataset.act };
    if (el.dataset.sq) action.square = +el.dataset.sq;
    if (el.dataset.build) action.build = +el.dataset.build;
    return gameAct(action);
  }
  switch (el.dataset.do) {
    case 'offer': {
      const square = Number(el.dataset.sq);
      const g = S.table?.game;
      if (!g || !legalActions(g, S.user.id).some(a => a.type === 'offer' && a.square === square)) return;
      const input = prompt('输入挂牌价格（1–100000）', String(saleCost(g, square) + 100));
      if (input === null) return;
      const price = Number(input);
      if (!Number.isSafeInteger(price) || price < 1 || price > 100000) return toast('请输入 1–100000 的整数');
      return gameAct({ type: 'offer', square, price });
    }
    case 'logout':
      S.token = null; S.user = null; S.table = null; store('mf_token', null);
      S.ws?.close(); return render();
    case 'joinTable': {
      if (el.dataset.locked === 'true') {
        const code = prompt('这桌上锁了，请输入 6 位邀请码');
        if (code) send({ t: 'join', code: code.trim() });
      } else send({ t: 'join', tableId: el.dataset.id });
      return;
    }
    case 'copy':
      try { await navigator.clipboard.writeText(el.dataset.text); toast('已复制'); }
      catch { prompt('复制下面的内容', el.dataset.text); }
      return;
    case 'ready': return send({ t: 'ready', v: el.dataset.v === 'true' });
    case 'start': return send({ t: 'start' });
    case 'leave': return send({ t: 'leave' });
    case 'again': return send({ t: 'again' });
    case 'select': {
      const i = +el.dataset.i;
      S.selected = S.selected === i ? null : i;
      return render();
    }
  }
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.do === 'lock') send({ t: 'lock', v: e.target.checked });
});

connect();
render();
