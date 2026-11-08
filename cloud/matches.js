import { GitHubState } from './storage.js';

// Each finished game has its own durable outbox and immutable GitHub path.
// The caller keeps the full record until the archive object acknowledges its local commit.
export async function deliverArchive(env, scope, record) {
  const key = scope + '/' + record.matchId;
  const stub = env.ARCHIVES.getByName(key);
  const response = await stub.fetch('https://internal/archive/' + key, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(record),
  });
  if (!response.ok) throw new Error('Match archive refused (' + response.status + ')');
}

export class MatchArchive {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    const match = /^\/archive\/(online|[A-HJ-NP-Z2-9]{4})\/([a-f0-9-]{32,36})$/.exec(path);
    if (req.method !== 'POST' || !match) return new Response('Not found', { status: 404 });
    const [, scope, matchId] = match;
    const key = 'matches/' + scope + '/' + matchId;
    const record = await req.json();
    if (
      record.matchId !== matchId ||
      record.game?.status !== 'ended' ||
      !record.game.ranking?.length ||
      !Number.isFinite(record.finishedAt) ||
      (scope !== 'online' && record.code !== scope)
    ) {
      return new Response('Invalid completed match', { status: 400 });
    }
    const store = new GitHubState(this.ctx, this.env, key);
    // Only the originating object can call this internal route. Retry after a lost
    // response must not revise a completed game's immutable GitHub snapshot.
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const existingKey = await this.ctx.storage.get('archiveKey');
      if (existingKey && existingKey !== key) return 409;
      if (existingKey && (await this.ctx.storage.get('sync'))) {
        const existing = await store.load();
        return JSON.stringify(existing) === JSON.stringify(record) ? 200 : 409;
      }
      await this.ctx.storage.put('archiveKey', key);
      await store.save(record);
      return 201;
    });
    return new Response(null, { status: result });
  }

  async alarm() {
    const key = await this.ctx.storage.get('archiveKey');
    if (!key) return;
    const store = new GitHubState(this.ctx, this.env, key);
    try {
      await store.flush();
    } finally {
      const next = await store.getNextFlushAt();
      if (next != null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
    }
  }
}
