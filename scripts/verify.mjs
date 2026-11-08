// Launch an isolated Worker and run through the same HTTP, WS and browser entry points as production.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function run(script, ...args) {
  const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit', cwd: dir });
  const [code] = await once(p, 'exit');
  if (code !== 0) throw new Error(script + ' exited with ' + code);
}
const dir = await mkdtemp(path.join(tmpdir(), 'party-tycoon-verify-'));
const reserve = createServer().listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const base = 'http://127.0.0.1:' + port;
let worker;
try {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // A dev server hot-reloads open sockets on edits. Freeze precisely what this run verifies.
  for (const name of ['public', 'shared', 'cloud', 'test', 'scripts', 'package.json', 'wrangler.jsonc'])
    await cp(path.join(root, name), path.join(dir, name), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  await run('scripts/assets.mjs');
  await run('test/rules-regression.mjs');
  await run('test/git-budget.mjs');
  await run('test/sim.mjs');
  await run('test/cloud-room-state.mjs');
  worker = spawn(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      '--port',
      String(port),
      '--var',
      'STORAGE_MODE:local',
      '--persist-to',
      path.join(dir, 'runtime'),
      '--log-level',
      'error',
    ],
    { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const started = Date.now();
  for (;;) {
    if (worker.exitCode != null || Date.now() - started > 30000) throw new Error('本地 Worker 启动失败');
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await delay(150);
  }
  for (const script of ['cloud-save', 'cloud-lobby', 'cloud-room', 'e2e', 'web', 'cloud-save-web'])
    await run('test/' + script + '.mjs', base);
  await run('test/cloud-recovery.mjs');
} finally {
  if (worker && worker.exitCode == null) {
    const finished = once(worker, 'exit');
    worker.kill('SIGTERM');
    await finished;
  }
  await rm(dir, { recursive: true, force: true });
}
