// The browser's local snapshot stays immediately playable while its private cloud copy syncs.
const snapshotKey = 'mf_local_v2', pairKey = 'mf_cloud_pair_v1';
let active = false, generation = 0, changes = 0, pair, pending, timer, running = false;
let restoring = false, conflict = false, status = '尚未创建云存档';
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const keepPair = () => { try { localStorage.setItem(pairKey, JSON.stringify(pair)); } catch {} };
const endpoint = p => '/api/saves/' + p.id;
const auth = p => ({Authorization:'Bearer '+p.token});
const same = (a,b) => a?.state?.startedAt === b?.state?.startedAt;
function schedule(delay=400) {
  clearTimeout(timer);
  if (active && !conflict && pending && !restoring) timer=setTimeout(write,delay);
}
function update(message) {
  status=message;
  const label=document.getElementById('cloudStatus');
  if (label) label.textContent=message;
}
async function write() {
  if (running || restoring || conflict || !pending) return;
  running=true;
  const gen=generation;
  const item=pending;
  try {
    if (!pair) {
      const r=await fetch('/api/saves',{method:'POST',signal:AbortSignal.timeout(12000)});
      if (!r.ok) throw Error('云存档暂不可用');
      const created=await r.json();
      if (gen!==generation) return;
      pair={id:created.id,token:created.token,revision:0}; keepPair();
    }
    const p=pair;
    const r=await fetch(endpoint(p),{method:'PUT',headers:{...auth(p),'Content-Type':'application/json','If-Match':String(p.revision)},
      body:JSON.stringify(item),signal:AbortSignal.timeout(12000)});
    if (gen!==generation) return;
    if (r.status===409) {
      // A lost response and a concurrent edit both look like a revision mismatch.
      const latest=await fetch(endpoint(p),{headers:auth(p),signal:AbortSignal.timeout(12000)});
      if (!latest.ok) throw Error('读取云存档失败');
      const remote=await latest.json();
      if (gen!==generation) return;
      if (JSON.stringify(remote.slot)!==JSON.stringify(item)) {
        conflict=true;
        update('另一设备更新了云存档。当前对局已保存在本机，可另存为新的云存档。');
        return;
      }
      p.revision=remote.revision;
    } else {
      if (!r.ok) throw Error('云存档暂不可用');
      p.revision=(await r.json()).revision;
    }
    if (gen!==generation) return;
    keepPair();
    if (pending===item) pending=null;
    update('已同步，可用专属恢复链接继续');
  } catch {
    if (gen===generation) update('已保存在本机，联网后会继续同步');
  } finally {
    running=false;
    schedule(pending===item ? 10000 : 200);
  }
}
export function queueCloudSave(snapshot) {
  if (!active || !snapshot?.state) return;
  changes++;
  pending=structuredClone(snapshot);
  schedule();
}
export function newCloudGame() {
  // A pending update to the previous game must finish before we forget its capability.
  if (pending && pair) {
    const p={...pair}, item=pending;
    void fetch(endpoint(p),{method:'PUT',headers:{...auth(p),'If-Match':String(p.revision),'Content-Type':'application/json'},
      body:JSON.stringify(item),keepalive:true}).catch(()=>{});
  }
  generation++; changes++; pair=null; pending=null; conflict=false; restoring=false; clearTimeout(timer); keepPair();
  update('新对局将在开始后备份');
}

export async function startCloudSave({restore}) {
  active=true;
  const match=location.hash.match(/^#save=([a-f0-9]{32})\.([a-f0-9]{64})$/);
  const existing=read(pairKey);
  pair=match ? {id:match[1],token:match[2],revision:0} : existing;
  const local=read(snapshotKey);
  if (!pair) {if (local?.state) queueCloudSave(local); return;}
  const gen=generation, change=changes;
  restoring=true;
  try {
    const r=await fetch(endpoint(pair),{headers:auth(pair),signal:AbortSignal.timeout(12000)});
    if (!r.ok) throw Error('恢复失败');
    const remote=await r.json();
    if (gen!==generation || changes!==change) return;
    pair.revision=remote.revision; keepPair();
    if (remote.slot && (match || !local || (same(remote.slot,local) && remote.slot.state.seq>local.state.seq))) {
      restore(remote.slot);
    } else if (local && (!remote.slot || (same(remote.slot,local) && local.state.seq>=remote.slot.state.seq))) {
      if (existing && !match && existing.revision !== remote.revision && JSON.stringify(local)!==JSON.stringify(remote.slot)) {
        conflict=true; update('另一设备已更新云存档，当前本地对局可另存。'); return;
      }
      if (JSON.stringify(local)!==JSON.stringify(remote.slot)) pending=local;
    }
    if (match) history.replaceState(null,'',location.pathname+location.search);
    update('云存档已连接');
  } catch {
    // Keep an incoming recovery capability in the fragment until successfully loaded.
    update('暂时无法读取云存档，本机对局仍可继续');
    if (local && !match) pending=local;
  } finally {
    if (gen===generation) {restoring=false; schedule();}
  }
}

export function showCloudSave() {
  if (!active) return;
  if (document.getElementById('cloudDialog')) return;
  const dialog=document.createElement('dialog'); dialog.id='cloudDialog';
  dialog.innerHTML='<h2>单机云存档</h2><p id="cloudStatus"></p><p>持有恢复链接的人可以读取和继续这局游戏。</p><div class="btns"><button class="btn gold" data-cloud="copy">复制恢复链接</button><button class="btn" data-cloud="retry"></button><button class="btn" data-cloud="close">关闭</button></div>';
  document.body.append(dialog); update(status);
  const retry=dialog.querySelector('[data-cloud=retry]');
  retry.textContent=conflict?'另存当前对局':'立即同步';
  dialog.querySelector('[data-cloud=copy]').onclick=async()=>{
    if (!pair || !pair.revision) {update('开局并同步后即可复制恢复链接');return;}
    const url=location.origin+'/local#save='+pair.id+'.'+pair.token;
    try {await navigator.clipboard.writeText(url);update('已复制恢复链接');} catch {window.prompt('复制恢复链接',url);}
  };
  retry.onclick=()=>{if(conflict) newCloudGame(); const saved=read(snapshotKey); if(saved) queueCloudSave(saved); schedule(0);};
  dialog.querySelector('[data-cloud=close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>dialog.remove(),{once:true}); dialog.showModal();
}
