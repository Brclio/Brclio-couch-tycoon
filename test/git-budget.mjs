// One fake clock covers both rolling quota windows and GitHub's UTC reset headers.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { GitBudget } from '../cloud/git-budget.js';
import { GitHubState } from '../cloud/storage.js';

class MemoryStorage {
  map = new Map();
  tail = Promise.resolve();
  alarm = null;
  async get(key) {
    if (Array.isArray(key))
      return new Map(key.filter((k) => this.map.has(k)).map((k) => [k, structuredClone(this.map.get(k))]));
    return structuredClone(this.map.get(key));
  }
  async put(key, value) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at) {
    this.alarm = at;
  }
  transaction(fn) {
    const next = this.tail.then(() => fn(this));
    this.tail = next.catch(() => {});
    return next;
  }
}

const epoch = 1_800_000_000_000;
const minute = 60_000,
  hour = 60 * minute;
let now = epoch;
const savedNow = Date.now,
  savedRandom = Math.random,
  savedFetch = globalThis.fetch;
Date.now = () => now;
Math.random = () => 0.5;
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

function environment(withBinding = true) {
  const quota = new MemoryStorage();
  const env = {
    GITHUB_REPOSITORY: 'fixture/private',
    GITHUB_BRANCH: 'main',
    GITHUB_APP_CLIENT_ID: 'test-app',
    GITHUB_APP_PRIVATE_KEY: key,
  };
  if (withBinding)
    env.GIT_BUDGET = {
      getByName(repo) {
        assert.equal(repo, env.GITHUB_REPOSITORY.toLowerCase());
        return { fetch: (u, init) => new GitBudget({ storage: quota }).fetch(new Request(u, init)) };
      },
    };
  return env;
}

function store(env, key) {
  const storage = new MemoryStorage();
  return new GitHubState({ storage }, env, key);
}

function installFixture(handler) {
  let calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/installation')) return Response.json({ id: 100 });
    if (path.endsWith('/access_tokens'))
      return Response.json({ token: 'unit-fixture', expires_at: new Date(epoch + 86400000).toISOString() });
    assert.equal(options.headers.Authorization, 'Bearer unit-fixture');
    const call = { path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

async function control(env, path, data) {
  const r = await env.GIT_BUDGET.getByName(env.GITHUB_REPOSITORY.toLowerCase()).fetch(
    'https://internal/' + path,
    {
      method: path === 'status' ? 'GET' : 'POST',
      body: data ? JSON.stringify(data) : undefined,
    },
  );
  assert.equal(r.status, 200);
  return (await r.json()).retryAt;
}

try {
  {
    const env = environment();
    const simultaneous = await Promise.all([control(env, 'reserve'), control(env, 'reserve')]);
    assert.deepEqual(simultaneous, [null, epoch + 1000]);
    for (let i = 1; i < 420; i++) {
      now = epoch + i * 1000;
      assert.equal(await control(env, 'reserve'), null);
    }
    now += 1000;
    assert.equal(await control(env, 'reserve'), epoch + hour);
    assert.equal(await control(env, 'status'), null, 'local content quota must allow reads');
    now = epoch + hour;
    assert.equal(await control(env, 'reserve'), null);
    assert.equal(await control(env, 'reserve'), now + 1000);
    console.log(
      '✓ Per-repository rolling 420/hour, one-second spacing, concurrent admission, cold instances',
    );
  }
  {
    now = epoch;
    const env = environment();
    let throttle = true,
      savedEnvelope = null;
    const calls = installFixture((c) => {
      if (c.path === '/repos/fixture/private') return Response.json({ private: true });
      assert.equal(c.method, 'PUT');
      if (throttle)
        return Response.json(
          { message: 'API rate limit exceeded' },
          {
            status: 403,
            headers: {
              'retry-after': '120',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String((now + hour) / 1000),
            },
          },
        );
      savedEnvelope = JSON.parse(gunzipSync(Buffer.from(c.body.content, 'base64')).toString());
      return Response.json({ content: { sha: 'saved' } });
    });
    const a = store(env, 'rooms/AAAA'),
      b = store(env, 'rooms/BBBB');
    await a.save({ value: 1 });
    await b.save({ value: 2 });
    now += 15000;
    await a.flush();
    const deadline = now + hour;
    assert.equal(await control(env, 'status'), deadline);
    assert.ok((await a.getNextFlushAt()) >= deadline);
    const count = calls.length;
    await b.flush();
    await assert.rejects(store(env, 'rooms/CCCC').load(), /cooldown/);
    assert.equal(calls.length, count, 'sibling must make no remote call during rate limit');
    await a.save({ value: 3 });
    assert.deepEqual(await a.load(), { value: 3 });
    assert.ok((await a.getNextFlushAt()) >= deadline);
    now = await a.getNextFlushAt();
    throttle = false;
    await new GitHubState({ storage: a.storage }, env, a.key).flush();
    assert.deepEqual(savedEnvelope.snapshot, { value: 3 });
    assert.equal(savedEnvelope.revision, 2);
    assert.equal(await a.getNextFlushAt(), null);
    console.log(
      '✓ 403 primary reset + Retry-After, shared reader/writer deferral, coalesced retry after eviction',
    );
  }
  {
    now = epoch;
    const env = environment();
    let mode = 'private-forbidden';
    installFixture(() => {
      if (mode === 'private-forbidden')
        return Response.json({ message: 'Resource not accessible by integration' }, { status: 403 });
      if (mode === 'public') return Response.json({ private: false });
      if (mode === 'secondary')
        return Response.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 });
      return Response.json(
        {},
        { status: 429, headers: { 'retry-after': new Date(now + 4 * minute).toUTCString() } },
      );
    });
    const cold = store(env, 'online/lobby');
    await assert.rejects(cold.load(), /access denied/);
    assert.equal(await control(env, 'status'), null);
    mode = 'public';
    await assert.rejects(cold.load(), /private data repository/);
    mode = 'secondary';
    await assert.rejects(cold.load(), /throttled/);
    assert.equal(await control(env, 'status'), now + minute);
    now += minute;
    await assert.rejects(cold.load(), /throttled/);
    assert.equal(await control(env, 'status'), now + 2 * minute);
    now += 2 * minute;
    mode = '429-date';
    await assert.rejects(cold.load(), /throttled/);
    assert.equal(await control(env, 'status'), now + 4 * minute);
    console.log(
      '✓ Private/auth 403, public repository refusal, read-side secondary exponential cooldown, HTTP-date Retry-After',
    );
  }
  {
    now = epoch;
    const env = environment();
    let sha = 'stale',
      current = { version: 1, key: 'online/lobby', revision: 0, snapshot: { old: true } };
    const puts = [];
    installFixture((c) => {
      if (c.path === '/repos/fixture/private') return Response.json({ private: true });
      if (c.method === 'GET')
        return Response.json({
          sha,
          encoding: 'base64',
          content: gzipSync(JSON.stringify(current)).toString('base64'),
        });
      puts.push(c.body);
      if (c.body.sha !== sha) return Response.json({}, { status: 409 });
      current = JSON.parse(gunzipSync(Buffer.from(c.body.content, 'base64')).toString());
      sha = 'accepted';
      return Response.json({ content: { sha } });
    });
    const s = store(env, 'online/lobby');
    await s.save({ new: true });
    now = await s.getNextFlushAt();
    await s.flush();
    assert.equal(puts.length, 1, 'second PUT must obtain a new permit');
    assert.equal((await s.storage.get('sync')).sha, 'stale');
    assert.ok((await s.getNextFlushAt()) > now);
    now = await s.getNextFlushAt();
    await s.flush();
    assert.equal(puts.length, 2);
    assert.equal(puts[1].sha, 'stale');
    assert.deepEqual(current.snapshot, { new: true });
    assert.equal(await s.getNextFlushAt(), null);
    const duplicate = store(env, 'online/lobby');
    await duplicate.save({ new: true });
    now = await duplicate.getNextFlushAt();
    await duplicate.flush();
    assert.equal(puts.length, 3, 'accepted-but-lost response should reconcile via GET alone');
    assert.equal(await duplicate.getNextFlushAt(), null);
    console.log(
      '✓ 409 conflict recovery keeps corrected SHA when retry denied, duplicate commit adopted by revision and content',
    );
  }
  {
    now = epoch;
    const env = environment(false);
    const calls = installFixture((c) =>
      c.method === 'GET'
        ? Response.json({ private: true })
        : Response.json({}, { status: 429, headers: { 'retry-after': '121' } }),
    );
    const s = store(env, 'rooms/AAAA');
    await s.save({ active: true });
    now = await s.getNextFlushAt();
    await s.flush();
    assert.ok((await s.getNextFlushAt()) >= now + 121000);
    assert.deepEqual(await s.load(), { active: true });
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
    console.log('✓ No-binding fixture honors Retry-After and retains data');
  }
  {
    now = epoch;
    const env = environment();
    env.GITHUB_REPOSITORY = 'fixture/app-token';
    const cold = store(env, 'rooms/CCCC');
    let mode = 'installation',
      requests = 0;
    globalThis.fetch = async (url) => {
      requests++;
      if (mode === 'outage') throw new Error('network unavailable');
      if (mode !== 'installation' && url.endsWith('/installation')) return Response.json({ id: 987 });
      if (mode === 'permission') return Response.json({ message: 'Missing permission' }, { status: 403 });
      return Response.json({}, { status: 429, headers: { 'retry-after': '76' } });
    };
    await assert.rejects(cold.load(), /throttled/);
    assert.equal(await control(env, 'status'), now + 76000);
    await assert.rejects(cold.load(), /cooldown/);
    assert.equal(requests, 1);
    now += 76000;
    mode = 'permission';
    await assert.rejects(cold.load(), /access denied/);
    assert.equal(await control(env, 'status'), null);
    mode = 'token';
    await assert.rejects(cold.load(), /throttled/);
    assert.equal(await control(env, 'status'), now + 76000);
    now += 76000;
    mode = 'outage';
    await assert.rejects(cold.load(), /temporarily unavailable/);
    assert.ok((await control(env, 'status')) >= now + 5000);
    const total = requests;
    await assert.rejects(cold.load(), /cooldown/);
    assert.equal(requests, total);
    console.log(
      '✓ Installation lookup and token issuance propagate real throttle and permission failures; outages pause sibling API calls',
    );
  }
  {
    now = epoch;
    const env = environment(),
      s = store(env, 'rooms/DDDD');
    let repeated = true;
    const calls = installFixture((c) => {
      if (c.path === '/repos/fixture/private') return Response.json({ private: true });
      if (c.method === 'GET') return Response.json({}, { status: 404 });
      return repeated
        ? Response.json({}, { status: 409 })
        : Response.json({ message: 'Invalid path' }, { status: 422 });
    });
    await s.save({ value: 0 });
    now = await s.getNextFlushAt();
    await s.flush();
    now = await s.getNextFlushAt();
    await s.flush();
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
    const reads = calls.filter((c) => c.method === 'GET').length;
    now = await s.getNextFlushAt();
    repeated = false;
    await s.flush();
    assert.equal(calls.filter((c) => c.method === 'GET').length, reads);
    assert.equal(await control(env, 'status'), null);
    assert.deepEqual(await s.load(), { value: 0 });
    console.log(
      '✓ Repeated SHA conflicts and permanent validation errors preserve dirty data without triggering secondary-limit cooldown',
    );
  }
} finally {
  Date.now = savedNow;
  Math.random = savedRandom;
  globalThis.fetch = savedFetch;
}
