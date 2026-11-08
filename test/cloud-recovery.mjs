// Actual workerd restarts with empty DO disks and a private GitHub Contents API fixture.
// No credentials, network to GitHub, or persistent files are required.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'party-restore-test-'));
const contents = new Map();
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let generation = 0;
const api = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://test').pathname;
  res.setHeader('Content-Type', 'application/json');
  const respond = (status, body) => {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  };
  if (pathname === '/repos/fixture/private/installation' || pathname === '/app/installations/42/access_tokens') {
    const jwt = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
    if (
      jwt.length !== 3 ||
      !verify('sha256', Buffer.from(jwt.slice(0, 2).join('.')), publicKey, Buffer.from(jwt[2], 'base64url'))
    )
      return respond(401, {});
    if (pathname.endsWith('installation')) return respond(200, { id: 42 });
    let body = '';
    for await (const part of req) body += part;
    const scope = JSON.parse(body);
    assert.deepEqual(scope.repositories, ['private']);
    assert.deepEqual(scope.permissions, { contents: 'write' });
    return respond(201, { token: 'test-secret', expires_at: new Date(Date.now() + 3600000).toISOString() });
  }
  if (req.headers.authorization !== 'Bearer test-secret') return respond(403, {});
  if (pathname === '/repos/fixture/private') return respond(200, { private: true });
  const key = pathname.replace('/repos/fixture/private/contents/', '');
  if (key === pathname) return respond(404, {});
  const entry = contents.get(key);
  if (req.method === 'GET') return respond(entry ? 200 : 404, entry || {});
  if (req.method !== 'PUT') return respond(405, {});
  let body = '';
  for await (const chunk of req) body += chunk;
  const update = JSON.parse(body);
  if ((entry?.sha || null) !== (update.sha || null)) return respond(409, {});
  const sha = String(++generation);
  contents.set(key, { sha, encoding: 'base64', content: update.content });
  return respond(entry ? 200 : 201, { content: { sha } });
});

let server;
const sockets = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(f, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const result = await f();
    if (result) return result;
    if (Date.now() >= end) throw new Error('等待超时：' + what);
    await delay(30);
  }
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exit = once(server, 'exit');
  server.kill('SIGTERM');
  await exit;
}
async function launch(port, disk) {
  server = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--port',
      String(port),
      '--persist-to',
      path.join(temp, disk),
      '--log-level',
      'error',
    ],
    { cwd: temp, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  server.stderr.on('data', (b) => process.stderr.write(b));
  const base = 'http://127.0.0.1:' + port;
  await until(
    async () => {
      if (server.exitCode !== null) throw new Error('workerd 启动失败');
      try {
        return (await fetch(base + '/api/health-test')).status === 404;
      } catch {
        return false;
      }
    },
    '启动 workerd',
    20000
  );
  return base;
}
async function connect(base, code, token = '') {
  const url = new URL('/ws', base);
  url.protocol = 'ws:';
  url.search = new URLSearchParams({ party: 'phone', room: code, token });
  const ws = new WebSocket(url);
  sockets.add(ws);
  const c = { ws, room: null, token: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'room') Object.assign(c, { room: m.room, me: m.me });
    if (m.t === 'token') c.token = m.token;
    if (m.t === 'denied' || m.t === 'error') c.failure = m;
  });
  await until(() => {
    if (c.failure) throw new Error(JSON.stringify(c.failure));
    return c.token && c.room;
  }, '连接并恢复座位');
  c.send = (m) => ws.send(JSON.stringify(m));
  return c;
}
function readRemote(key) {
  const file = contents.get('state/v1/' + key + '.json.gz');
  return file && JSON.parse(gunzipSync(Buffer.from(file.content, 'base64')));
}
try {
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const fixtureBase = 'http://127.0.0.1:' + api.address().port;
  // Retain real request signing, compression, revisions and HTTP status handling.
  // Only the transport destination changes in this temporary Worker.
  await writeFile(
    path.join(temp, 'worker.mjs'),
    `
    import worker from ${JSON.stringify(path.join(root, 'cloud/worker.js'))};
    export { GuestRoom, MatchArchive } from ${JSON.stringify(path.join(root, 'cloud/room.js'))};
    export { Lobby } from ${JSON.stringify(path.join(root, 'cloud/lobby.js'))};
    export { LocalSave } from ${JSON.stringify(path.join(root, 'cloud/save.js'))};
    export { GitBudget } from ${JSON.stringify(path.join(root, 'cloud/git-budget.js'))};
    const original=globalThis.fetch.bind(globalThis);
    globalThis.fetch=(url, init)=>original(typeof url==='string' && url.startsWith('https://api.github.com/')
      ? url.replace('https://api.github.com',${JSON.stringify(fixtureBase)}) : url,init);
    export default worker;
  `
  );
  const classes = { ROOMS: 'GuestRoom', ARCHIVES: 'MatchArchive', LOBBY: 'Lobby', SAVES: 'LocalSave', GIT_BUDGET: 'GitBudget' };
  await writeFile(
    path.join(temp, 'wrangler.json'),
    JSON.stringify({
      name: 'party-recovery-test',
      main: 'worker.mjs',
      compatibility_date: '2026-06-01',
      vars: {
        GITHUB_REPOSITORY: 'fixture/private',
        GITHUB_APP_CLIENT_ID: 'test-app',
        GITHUB_BRANCH: 'main',
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
      durable_objects: { bindings: Object.entries(classes).map(([name, class_name]) => ({ name, class_name })) },
      migrations: [{ tag: 'v1', new_sqlite_classes: Object.values(classes) }],
    })
  );
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  let base = await launch(port, 'before');
  const response = await fetch(base + '/api/rooms', { method: 'POST' });
  assert.equal(response.status, 201);
  const { code, token } = await response.json();
  let host = await connect(base, code, token),
    guest = await connect(base, code);
  const guestToken = guest.token,
    guestId = guest.me;
  for (const [i, p] of [host, guest].entries()) {
    p.send({ t: 'pick', code: i ? '1f43c' : '1f436' });
    p.send({ t: 'ready', v: true });
  }
  await until(() => host.room.seats.every((s) => s.ready), '准备');
  host.send({ t: 'start' });
  await until(() => host.room.status === 'playing', '开局');
  host.send({ t: 'pause' });
  await until(() => host.room.paused, '暂停并冻结对局');
  const initial = await until(
    () => {
      const snap = readRemote('rooms/' + code)?.snapshot;
      return snap?.pausedAt && snap;
    },
    'GitHub 保存完整对局',
    35000
  );
  assert(Array.isArray(initial.game.deck));
  assert.equal(initial.game.deck.length, 12);
  assert(!JSON.stringify(initial).includes(token));
  assert(!JSON.stringify(initial).includes(guestToken));
  await stop();
  // A new disk forces restoration from the GitHub response rather than the DO cache.
  base = await launch(port, 'after');
  host = await connect(base, code, token);
  guest = await connect(base, code, guestToken);
  assert.equal(guest.me, guestId);
  assert.deepEqual(host.room.game.players, initial.game.players);
  assert.equal(host.room.game.seq, initial.game.seq);
  assert.equal(host.room.game.deckLeft, initial.game.deck.length);
  assert(host.room.paused);
  host.send({ t: 'finish' });
  await until(() => host.room.status === 'ended', '主持人结算');
  const final = structuredClone(host.room.game);
  host.send({ t: 'again' });
  await until(() => host.room.status === 'waiting', '立即重赛');
  const archive = await until(
    () => readRemote('matches/' + code + '/' + initial.matchId)?.snapshot,
    'GitHub 终局独立存档',
    35000
  );
  assert.deepEqual(archive.game.ranking, final.ranking);
  assert.deepEqual(archive.game.deck, initial.game.deck);
  assert.equal(archive.game.endReason, 'host');
  await until(() => readRemote('rooms/' + code)?.snapshot.status === 'waiting', '最新房间与终局并存', 35000);
  assert.equal(readRemote('rooms/' + code).snapshot.lastCompleted.matchId, initial.matchId);
  console.log('✓ 整局 GitHub 写入、空白运行时恢复座位/牌堆/暂停状态、立即重赛后独立终局回读');
} finally {
  for (const ws of sockets) if (ws.readyState < 2) ws.close();
  await stop();
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  await rm(temp, { force: true, recursive: true });
}
