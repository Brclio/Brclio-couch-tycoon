import { BOARD_SIZE, CARDS, CHARS, OWNABLE, PLAYER_COLORS } from '../shared/board.js';
import { GitHubState } from './storage.js';
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const hash = async (value) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

async function readSlot(req) {
  const max = 175_000,
    reader = req.body?.getReader();
  if (!reader) return null;
  let total = 0,
    raw = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    raw += decoder.decode(value, { stream: true });
  }
  let slot;
  try {
    slot = JSON.parse(raw + decoder.decode());
  } catch {
    return null;
  }
  const g = slot?.state;
  const inRange = (n, lo, hi) => Number.isSafeInteger(n) && lo <= n && n <= hi;
  const tile = (n) => inRange(n, 0, BOARD_SIZE - 1);
  const actor = (id) => typeof id === 'string' && /^[A-F]$/.test(id);
  if (
    !g ||
    !['playing', 'ended'].includes(g.status) ||
    !inRange(g.seq, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(g.players) ||
    !inRange(g.players.length, 2, 6)
  )
    return null;
  const ids = new Set(g.players.map((p) => p?.id));
  const known = (id) => ids.has(id);
  if (
    ids.size !== g.players.length ||
    !known(slot.viewer) ||
    !g.players.every(
      (p) =>
        p &&
        actor(p.id) &&
        typeof p.name === 'string' &&
        p.name.length <= 24 &&
        (p.avatar == null || CHARS.some((c) => c.code === p.avatar)) &&
        PLAYER_COLORS.includes(p.color) &&
        inRange(p.cash, 0, Number.MAX_SAFE_INTEGER) &&
        tile(p.pos) &&
        typeof p.bankrupt === 'boolean' &&
        typeof p.inJail === 'boolean' &&
        inRange(p.jailCards, 0, 1) &&
        Array.isArray(p.owed) &&
        p.owed.every(
          (o) => o && (o.to === null || known(o.to)) && inRange(o.amount, 1, Number.MAX_SAFE_INTEGER),
        ),
    )
  )
    return null;
  if (
    !Array.isArray(g.order) ||
    g.order.length !== ids.size ||
    new Set(g.order).size !== ids.size ||
    !g.order.every((i) => inRange(i, 0, ids.size - 1)) ||
    !inRange(g.turnIdx, 0, ids.size - 1) ||
    !['roll', 'buy', 'manage', 'debt', 'ended'].includes(g.phase) ||
    (g.status === 'ended') !== (g.phase === 'ended') ||
    !Array.isArray(g.deck) ||
    !Array.isArray(g.discard) ||
    ![...g.deck, ...g.discard].every((id) => CARDS.some((c) => c.id === id)) ||
    !g.props ||
    typeof g.props !== 'object' ||
    Array.isArray(g.props) ||
    !Object.entries(g.props).every(
      ([i, p]) => OWNABLE.includes(+i) && p && known(p.owner) && inRange(p.houses, 0, 5),
    ) ||
    (g.pending && !OWNABLE.includes(g.pending.square)) ||
    (g.phase === 'buy' && !g.pending) ||
    (g.offer && (!known(g.offer.from) || !g.props[g.offer.square])) ||
    (g.stop && (!tile(g.stop.square) || !inRange(g.stop.built, 0, 2))) ||
    !Array.isArray(g.events) ||
    !Array.isArray(g.log) ||
    !g.log.every((l) => l && typeof l.msg === 'string') ||
    ![g.deadline, g.startedAt, g.round].every(Number.isFinite) ||
    (g.status === 'ended' &&
      (!known(g.winner) || !Array.isArray(g.ranking) || !g.ranking.every((r) => r && known(r.id)))) ||
    !Array.isArray(slot.feed) ||
    slot.feed.length > 40 ||
    !slot.feed.every(
      (f) =>
        f &&
        (f.from == null || known(f.from)) &&
        (f.to == null || known(f.to)) &&
        typeof f.why === 'string' &&
        Number.isSafeInteger(f.amount),
    )
  )
    return null;
  const cardIds = [...g.deck, ...g.discard];
  const held = CARDS.find((card) => card.kind === 'jailcard').id;
  for (const p of g.players) if (p.jailCards) cardIds.push(held);
  if (cardIds.length !== CARDS.length || new Set(cardIds).size !== CARDS.length) return null;
  if (
    g.status === 'playing' &&
    (g.players[g.order[g.turnIdx]].bankrupt || g.players.filter((p) => !p.bankrupt).length < 2)
  )
    return null;
  return { state: g, viewer: slot.viewer, feed: slot.feed };
}

export class LocalSave {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.tail = Promise.resolve();
  }
  serial(fn) {
    const work = this.tail.then(fn);
    this.tail = work.catch(() => {});
    return work;
  }
  fetch(req) {
    return this.serial(async () => {
      const id = req.headers.get('x-save-id');
      if (!/^[a-f0-9]{32}$/.test(id || '')) return json({ error: '无效存档' }, 400);
      this.store ||= new GitHubState(this.ctx, this.env, 'local/' + id);
      const record = await this.store.load();
      if (new URL(req.url).pathname === '/api/saves' && req.method === 'POST') {
        if (record) return json({ error: '存档已存在' }, 409);
        const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
        await this.ctx.storage.put('slotId', id);
        await this.store.save({ hash: await hash(token), slot: null, revision: 0 });
        return json({ id, token, revision: 0 }, 201);
      }
      const token = req.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!record || !token || record.hash !== (await hash(token)))
        return json({ error: '存档链接无效' }, 404);
      await this.ctx.storage.put('slotId', id);
      if (req.method === 'GET') return json({ slot: record.slot, revision: record.revision });
      if (req.method !== 'PUT') return json({ error: '方法不支持' }, 405);
      const slot = await readSlot(req);
      if (req.headers.get('If-Match') !== String(record.revision))
        return json({ error: '另一台设备已更新存档', revision: record.revision }, 409);
      if (!slot) return json({ error: '存档格式不正确' }, 400);
      const revision = record.revision + 1;
      await this.store.save({ ...record, slot, revision });
      return json({ revision });
    });
  }
  alarm() {
    return this.serial(async () => {
      const id = await this.ctx.storage.get('slotId');
      if (!id) return;
      this.store ||= new GitHubState(this.ctx, this.env, 'local/' + id);
      await this.store.flush();
      const next = await this.store.getNextFlushAt();
      if (next != null) await this.ctx.storage.setAlarm(next);
    });
  }
}
