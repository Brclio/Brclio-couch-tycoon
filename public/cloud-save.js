// Each local game has an independent durable outbox. A new game can start while
// older games are uploading. Only the server-accepted revision advances its cursor.
const SNAPSHOT = 'mf_local_v2', PAIR = 'mf_cloud_pair_v1', PREFIX = 'mf_cloud_job_v2:';
const TAB = 'mf_cloud_job_tab_v2';
const memory = new Map();
let active = null, enabled = false, changes = 0, restoring = false, running = false, timer;
let notice = '', storageFailed = false, importedHash = '', restorePage;

function read(key) {
  if (memory.has(key)) return memory.get(key);
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    memory.delete(key);
  } catch {
    memory.set(key, value);
    if (!storageFailed) {
      storageFailed = true;
      const toast = document.getElementById('toast');
      if (toast) { toast.textContent = '浏览器存储空间不可用。待上传对局需要保持此页打开。'; toast.classList.add('show'); }
    }
  }
}
function jobs() {
  const keys = new Set(memory.keys());
  try { for (let i = 0; i < localStorage.length; i++) keys.add(localStorage.key(i)); } catch {}
  return [...keys].filter(k => k?.startsWith(PREFIX)).map(k => read(k)).filter(Boolean);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function fingerprint(snapshot) {
  const data = new TextEncoder().encode(JSON.stringify(snapshot));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, n => n.toString(16).padStart(2,'0')).join('');
}
const get = key => key ? read(PREFIX + key) : null;
const validPair = p => !!p && /^[a-f0-9]{32}$/.test(p.id) && /^[a-f0-9]{64}$/.test(p.token) && Number.isSafeInteger(p.revision) && p.revision >= 0;
const url = p => '/api/saves/' + p.id;
const auth = p => ({ Authorization: 'Bearer ' + p.token });
const link = p => location.origin + '/local#save=' + p.id + '.' + p.token;
function save(job) {
  write(PREFIX + job.key, job);
  const local = read(SNAPSHOT);
  if (job.key === active && (!local || local.state.startedAt === job.startedAt)) {
    write(PAIR, { ...job.pair, startedAt: job.startedAt, jobKey: job.key, baseline:job.baseline });
  }
}
function select(job) {
  active = job?.key || null;
  try { if (active) sessionStorage.setItem(TAB, active); else sessionStorage.removeItem(TAB); } catch {}
  if (job) save(job); else write(PAIR, null);
}
function create(startedAt, pair = null) {
  return { key: crypto.randomUUID(), startedAt, pair, pending: null, sent: null, conflict: false };
}
function describe() {
  const job = get(active), older = jobs().filter(j => j.key !== active && j.pending);
  const messages = [];
  if (notice) messages.push(notice);
  if (job?.conflict) messages.push((job.problem || '另一设备更新了云存档。') + '本机进度已保留，请另存本局。');
  else if (job?.pending) messages.push('本局已在本机排队，联网后继续上传。');
  else if (job?.pair?.revision) messages.push('已同步，可用专属恢复链接继续。');
  else if (!notice) messages.push('开局后自动备份。');
  if (older.length) messages.push(`另有 ${older.length} 个旧存档待同步或待解决冲突。`);
  if (storageFailed) messages.push('此浏览器无法持久保存待传数据，请保持页面打开直至上传成功。');
  return messages.join(' ');
}

async function fetchSlot(pair) {
  const r = await fetch(url(pair), { headers: auth(pair), signal: AbortSignal.timeout(10000), cache:'no-store' });
  if (!r.ok) throw Object.assign(Error(r.status === 404 ? '恢复链接无效或已失效。' : '暂时无法读取云存档。'), {status:r.status});
  return r.json();
}
async function synchronize(key) {
  let job = get(key);
  if (!job?.pending || job.conflict) return;
  // A v1 capability may have been attached to an unrelated game by an older client.
  // Confirm the stored game identity before its first offline/retried write.
  if (job.checkGame && job.pair) {
    let remote;
    try { remote = await fetchSlot(job.pair); }
    catch (error) {
      if (error.status !== 404) throw error;
    }
    job = get(key);
    if (!remote || (remote.slot && remote.slot.state.startedAt !== job.startedAt)) job.pair = null;
    job.checkGame = false;
    save(job);
  }
  if (!job.pair) {
    const r = await fetch('/api/saves', { method:'POST', signal:AbortSignal.timeout(10000) });
    if (!r.ok) throw Error('云存档暂不可用');
    const created = { ...(await r.json()), revision:0 };
    if (!validPair(created)) throw Error('云存档响应有误');
    job = get(key);
    if (!job) return;
    if (!job.pair) { job.pair = created; save(job); }
  }
  // A lost PUT response may represent an accepted write. Replay exactly that
  // payload and revision first, even if newer moves have joined the outbox.
  const item = job.sent || job.pending, pair = { ...job.pair };
  job.sent = item; save(job);
  const r = await fetch(url(pair), {
    method:'PUT', headers:{ ...auth(pair), 'Content-Type':'application/json', 'If-Match':String(pair.revision) },
    body:JSON.stringify(item), signal:AbortSignal.timeout(10000)
  });
  let revision;
  if (r.status === 409) {
    const remote = await fetchSlot(pair);
    if (!same(remote.slot, item)) {
      job = get(key);
      if (job?.pair?.id === pair.id && job.pair.revision === pair.revision) { job.conflict = true; save(job); }
      return;
    }
    revision = remote.revision;
  } else {
    if (r.status === 404 || r.status === 403 || r.status === 400) {
      job = get(key); job.conflict = true;
      job.problem = r.status === 400 ? '服务器拒绝了这份存档的数据格式。' : '原存档凭据已失效。';
      save(job); return;
    }
    if (!r.ok) throw Error('云存档写入失败');
    revision = (await r.json()).revision;
  }
  const baseline = await fingerprint(item);
  job = get(key);
  if (job?.pair?.id !== pair.id || job.pair.revision > revision) return;
  job.pair.revision = revision;
  job.baseline = baseline;
  job.sent = null;
  if (same(job.pending, item)) job.pending = null;
  save(job);
}
function plan(ms = 350) {
  clearTimeout(timer);
  if (enabled && !restoring) timer = setTimeout(flush, ms);
}
async function flush() {
  if (running || restoring) return;
  running = true;
  let retry = 300;
  try {
    for (const job of jobs().filter(j => j.pending && !j.conflict)) {
      try {
        // Two tabs can both replay an abandoned upload after the browser restarts.
        if (navigator.locks) await navigator.locks.request('tycoon-save-' + job.key, () => synchronize(job.key));
        else await synchronize(job.key);
      } catch { retry = 5000; }
    }
  } finally {
    running = false;
    refreshDialog();
    if (jobs().some(j => j.pending && !j.conflict)) plan(retry);
  }
}

export function queueCloudSave(snapshot) {
  if (!enabled || !snapshot?.state) return;
  changes++;
  cancelUnresolvedImport();
  let job = get(active);
  if (!job || job.startedAt !== snapshot.state.startedAt) {
    job = create(snapshot.state.startedAt);
    select(job);
  }
  job.pending = structuredClone(snapshot);
  save(job);
  plan();
  refreshDialog();
}

export function newCloudGame() {
  changes++;
  cancelUnresolvedImport();
  // The previous job keeps its own token, revision and final queued snapshot.
  select(null);
  notice = '';
  plan(0);
  refreshDialog();
}
function rememberLocal(local) {
  if (!local) return;
  const owned = get(active);
  if (owned?.startedAt === local.state.startedAt) return;
  const ref = read(PAIR);
  const old = ref?.jobKey && get(ref.jobKey);
  let pair = old?.startedAt === local.state.startedAt ? old.pair :
    validPair(ref) && (ref.startedAt == null || ref.startedAt === local.state.startedAt) ? ref : null;
  if (pair) pair = { id:pair.id, token:pair.token, revision:pair.revision };
  // New tabs get their own pending snapshot and revision cursor. Reloads keep
  // their original job. CAS detects simultaneous, divergent moves.
  const job = create(local.state.startedAt, pair);
  job.checkGame = !!pair && (old?.checkGame || !ref?.startedAt);
  if (pair) job.baseline = old?.baseline || ref?.baseline;
  select(job);
}

function cancelUnresolvedImport() {
  if (!importedHash || location.hash !== importedHash) return;
  clearFragment();
  notice = '已继续本机对局，未切换到恢复链接中的存档。';
}
function clearFragment() {
  importedHash = '';
  history.replaceState(null, '', location.pathname + location.search);
}
export async function startCloudSave({ restore }) {
  enabled = true;
  restorePage = restore;
  const local = read(SNAPSHOT);
  let previousTab;
  try { previousTab = get(sessionStorage.getItem(TAB)); } catch {}
  if (previousTab && local?.state?.startedAt === previousTab.startedAt) select(previousTab);
  else rememberLocal(local);
  const initial = get(active), hash = location.hash;
  const match = hash.match(/^#save=([a-f0-9]{32})\.([a-f0-9]{64})$/);
  importedHash = match ? hash : '';
  const savedPair = read(PAIR);
  const candidate = match ? { id:match[1], token:match[2], revision:0 } :
    initial?.pair || (!local && validPair(savedPair) ? savedPair : null);
  const generation = changes;
  if (local && initial && !initial.pending && !initial.pair) { initial.pending = local; save(initial); }
  restoring = true;
  try {
    if (hash.startsWith('#save=') && !match) { notice = '恢复链接格式无效。'; clearFragment(); }
    if (!candidate) {
      if (local && !initial?.pending) queueCloudSave(local);
      return;
    }
    if (!match && (initial?.pending || initial?.conflict)) return;
    const remote = await fetchSlot(candidate);
    const [localDigest, remoteDigest] = await Promise.all([fingerprint(local), fingerprint(remote.slot)]);
    if (changes !== generation) {
      if (match) cancelUnresolvedImport();
      return;
    }
    if (match || !local) {
      if (!remote.slot) { notice = '这个恢复链接还没有可读取的对局。'; clearFragment(); return; }
      if (local && initial && !same(local, remote.slot)) {
        // Explicitly opening a link must not flush a divergent local state into that link.
        if (initial.pair?.id === candidate.id && initial.pending) fork(initial);
        else if (initial.pair && initial.pair.id !== candidate.id && !initial.pending && initial.baseline !== localDigest) {
          initial.pending = local; save(initial);
        }
      }
      restore(remote.slot);
      const imported = create(remote.slot.state.startedAt, { id:candidate.id, token:candidate.token, revision:remote.revision });
      imported.baseline = remoteDigest;
      select(imported);
      if (match) clearFragment();
      return;
    }
    if (remote.slot && remote.slot.state.startedAt !== local.state.startedAt) {
      select(create(local.state.startedAt));
      queueCloudSave(local);
      notice = '本机对局与原链接不同，已另建存档。';
    } else if (same(remote.slot, local)) {
      initial.checkGame = false; initial.pair.revision = remote.revision; initial.baseline = remoteDigest;
      save(initial);
    } else if (candidate.revision !== remote.revision) {
      if (remote.slot && initial.baseline === localDigest) {
        restore(remote.slot);
        initial.checkGame = false; initial.pair.revision = remote.revision; initial.baseline = remoteDigest;
      } else {
        initial.conflict = true; initial.pending = local;
      }
      save(initial);
    } else {
      queueCloudSave(local);
    }
  } catch (error) {
    if (changes === generation) {
      if (match) {
        notice = error.status === 404 ? error.message : '暂时无法使用恢复链接；本机对局可以继续。';
        if (error.status === 404) clearFragment();
      }
      if (!match && local && !initial?.pending) {
        queueCloudSave(local);
      }
    }
  } finally {
    restoring = false;
    plan(0);
    refreshDialog();
  }
}

function fork(job) {
  job = get(job.key);
  const local = job?.pending;
  if (!local) return;
  // Preserve the original cloud link while moving the divergent local moves to a new slot.
  const branch = create(local.state.startedAt);
  branch.pending = local;
  if (job.key === active) select(branch); else save(branch);
  job.pending = null; job.sent = null; job.conflict = false; save(job);
  notice = '本机进度已另存，原恢复链接仍指向原存档。';
  plan(0); refreshDialog();
}
async function copy(pair) {
  if (!pair?.revision) return;
  try { await navigator.clipboard.writeText(link(pair)); notice = '恢复链接已复制。'; }
  catch { window.prompt('复制恢复链接', link(pair)); }
  refreshDialog();
}
function refreshDialog() {
  const dialog = document.getElementById('cloudDialog');
  if (!dialog) return;
  dialog.querySelector('#cloudStatus').textContent = describe();
  const job = get(active);
  const copyButton = dialog.querySelector('[data-cloud=copy]');
  copyButton.disabled = !job?.pair?.revision;
  const retry = dialog.querySelector('[data-cloud=retry]');
  retry.textContent = job?.conflict ? '另存当前对局' : '立即同步';
  const list = dialog.querySelector('[data-cloud=history]');
  list.replaceChildren();
  const seen = new Set([job?.pair?.id].filter(Boolean));
  for (const old of jobs().filter(j => j.key !== active).reverse()) {
    if (!old.pending && (!old.pair?.revision || seen.has(old.pair.id))) continue;
    if (old.pair) seen.add(old.pair.id);
    const li = document.createElement('li'), btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = old.conflict ? '另存冲突进度' : old.pair?.revision ? '复制恢复链接' : '等待上传';
    btn.disabled = !old.conflict && !old.pair?.revision;
    btn.onclick = () => old.conflict ? fork(old) : copy(old.pair);
    li.append(new Date(old.startedAt).toLocaleString() + ' ', btn);
    list.append(li);
  }
}
export function showCloudSave() {
  if (!enabled) return;
  let dialog = document.getElementById('cloudDialog');
  if (dialog) return;
  dialog = document.createElement('dialog');
  dialog.id = 'cloudDialog';
  dialog.innerHTML = '<h2>同屏云存档</h2><p id="cloudStatus" role="status"></p><p>持有恢复链接的人可以读取和继续这局游戏。</p><div class="btns"><button class="btn gold" data-cloud="copy">复制恢复链接</button><button class="btn" data-cloud="retry">立即同步</button><button class="btn" data-cloud="close">关闭</button></div><details><summary>此前的本机存档</summary><ul data-cloud="history"></ul></details>';
  document.body.append(dialog);
  refreshDialog();
  dialog.querySelector('[data-cloud=copy]').onclick = () => copy(get(active)?.pair);
  dialog.querySelector('[data-cloud=retry]').onclick = () => {
    const job = get(active);
    if (job?.conflict) fork(job);
    else if (importedHash && !restoring) startCloudSave({restore:restorePage});
    else { const local = read(SNAPSHOT); if (local && !job?.pending) queueCloudSave(local); plan(0); }
  };
  dialog.querySelector('[data-cloud=close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove(), { once:true });
  dialog.showModal();
}
window.addEventListener('online', () => {
  if (enabled && importedHash && !restoring) startCloudSave({restore:restorePage});
  else plan(0);
});
