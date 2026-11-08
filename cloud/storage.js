import { repositoryToken } from './github-auth.js';
// Each Durable Object owns one logical snapshot. Local chunking keeps values within
// the DO KV limit. The persistent outbox coalesces moves and survives eviction.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PART_BYTES = 48 * 1024;
const SYNC_INTERVAL = 15_000;

async function readSnapshot(storage, meta) {
  const keys = Array.from({ length: meta.parts }, (_, i) => 'snapshot:' + i);
  const bytes = new Uint8Array(meta.size);
  for (let i = 0; i < keys.length; i += 64) {
    const values = await storage.get(keys.slice(i, i + 64));
    for (let j = i; j < Math.min(keys.length, i + 64); j++) {
      const part = values.get(keys[j]);
      if (!part) throw new Error('Incomplete durable snapshot');
      bytes.set(part, j * PART_BYTES);
    }
  }
  return JSON.parse(decoder.decode(bytes));
}

async function writeSnapshot(storage, value, metadata) {
  const bytes = encoder.encode(JSON.stringify(value));
  const parts = Math.ceil(bytes.length / PART_BYTES);
  await storage.transaction(async tx => {
    const prev = await tx.get('sync');
    for (let i = 0; i < parts; i++)
      await tx.put('snapshot:' + i, bytes.slice(i * PART_BYTES, (i + 1) * PART_BYTES));
    for (let i = parts; i < (prev?.parts || 0); i++) await tx.delete('snapshot:' + i);
    await tx.put('sync', { ...metadata(prev), size: bytes.length, parts });
  });
}

function base64(bytes) {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}

async function compressed(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unpack(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

export class GitHubState {
  constructor(ctx, env, key) {
    this.storage = ctx.storage;
    this.env = env;
    this.key = key;
  }

  async api(endpoint, options = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.env.GITHUB_REPOSITORY || ''))
      throw new Error('Private GitHub storage is not configured');
    return fetch('https://api.github.com/repos/' + this.env.GITHUB_REPOSITORY + endpoint, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + await repositoryToken(this.env),
        'User-Agent': 'party-tycoon-storage', 'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(12000)
    });
  }

  async verifyRepository() {
    if (this.verifiedUntil > Date.now()) return;
    const r = await this.api('');
    if (!r.ok || (await r.json()).private !== true) throw new Error('A writable private data repository is required');
    this.verifiedUntil = Date.now() + 60_000;
  }

  get path() {
    return '/contents/state/v1/' + this.key.split('/').map(encodeURIComponent).join('/') + '.json.gz';
  }

  async remote() {
    await this.verifyRepository();
    const r = await this.api(this.path + '?ref=' + encodeURIComponent(this.env.GITHUB_BRANCH || 'main'));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub snapshot read failed (' + r.status + ')');
    const info = await r.json();
    let bytes;
    if (info.encoding === 'base64') {
      bytes = Uint8Array.from(atob(info.content.replace(/\s/g, '')), c => c.charCodeAt(0));
    } else {
      const blob = await this.api('/git/blobs/' + info.sha, {headers:{Accept:'application/vnd.github.raw+json'}});
      if (!blob.ok) throw new Error('GitHub blob read failed (' + blob.status + ')');
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    const envelope = await unpack(bytes);
    if (envelope.version !== 1 || envelope.key !== this.key || !Number.isSafeInteger(envelope.revision))
      throw new Error('Invalid GitHub snapshot');
    return { envelope, sha: info.sha };
  }

  async load() {
    const meta = await this.storage.get('sync');
    if (meta) return readSnapshot(this.storage, meta);
    if (this.env.STORAGE_MODE === 'local') return null;
    const remote = await this.remote();
    if (!remote) return null;
    await writeSnapshot(this.storage, remote.envelope.snapshot, () => ({
      revision: remote.envelope.revision, sha: remote.sha, next: null, failures: 0
    }));
    return remote.envelope.snapshot;
  }

  async save(snapshot) {
    const local = this.env.STORAGE_MODE === 'local';
    await writeSnapshot(this.storage, snapshot, previous => ({
      revision: (previous?.revision || 0) + 1,
      sha: previous?.sha || null, failures: previous?.failures || 0,
      next: local ? null : (previous?.next ?? Date.now() + SYNC_INTERVAL)
    }));
    const next = await this.getNextFlushAt();
    if (next != null) {
      const alarm = await this.storage.getAlarm();
      if (alarm === null || next < alarm) await this.storage.setAlarm(next);
    }
  }

  async getNextFlushAt() {
    return (await this.storage.get('sync'))?.next ?? null;
  }

  async flush() {
    const meta = await this.storage.get('sync');
    if (!meta?.next || meta.next > Date.now()) return;
    try {
      await this.verifyRepository();
      const value = await readSnapshot(this.storage, meta);
      const envelope = {version:1,key:this.key,revision:meta.revision,snapshot:value};
      const content = base64(await compressed(envelope));
      let sha = meta.sha;
      const put = () => this.api(this.path, {method:'PUT',body:JSON.stringify({
        message: 'Save ' + this.key + ' revision ' + meta.revision,
        branch: this.env.GITHUB_BRANCH || 'main', content, ...(sha ? {sha} : {})
      })});
      let r = await put();
      if (r.status === 409 || r.status === 422) {
        // A previous request may already have reached GitHub before its response was lost.
        const remote = await this.remote();
        if (remote && remote.envelope.revision >= meta.revision) {
          if (remote.envelope.revision !== meta.revision ||
              JSON.stringify(remote.envelope.snapshot) !== JSON.stringify(value))
            throw new Error('Conflicting newer remote snapshot');
          sha = remote.sha;
          r = null;
        } else {
          sha = remote?.sha || null;
          r = await put();
        }
      }
      if (r) {
        if (!r.ok) throw new Error('GitHub write failed (' + r.status + ')');
        sha = (await r.json()).content.sha;
      }
      await this.storage.transaction(async tx => {
        const current = await tx.get('sync');
        await tx.put('sync', {...current,sha,failures:0,next:current.revision === meta.revision ? null : Date.now()+SYNC_INTERVAL});
      });
    } catch (err) {
      console.error('Snapshot sync deferred', this.key, err.message);
      await this.storage.transaction(async tx => {
        const current = await tx.get('sync');
        const failures = (current.failures || 0) + 1;
        await tx.put('sync', {...current,failures,next:Date.now()+Math.min(300000,5000*2**Math.min(6,failures-1))});
      });
    }
  }
}
