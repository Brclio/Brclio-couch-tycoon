// The singleton for a data repository admits each actual Contents PUT, including retries.
// Denied reservations only read one bounded record and never enqueue a timer in this object.
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const HOURLY_WRITES = 420;
const MINUTE_WRITES = 60;
const QUOTA_KEY = 'quota';

export class GitBudget {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status' && request.method === 'GET') {
      const state = await this.storage.get(QUOTA_KEY);
      return Response.json({ retryAt: state?.until > Date.now() ? state.until : null });
    }
    if (request.method !== 'POST' || !['/reserve', '/cooldown'].includes(path)) {
      return new Response('Not found', { status: 404 });
    }
    const report = path === '/cooldown' ? await request.json() : null;
    if (report && !(Number.isSafeInteger(report.until) && report.until >= 0))
      return new Response('Bad deadline', { status: 400 });
    const retryAt = await this.storage.transaction(async (tx) => {
      const now = Date.now();
      const state = (await tx.get(QUOTA_KEY)) || { writes: [], until: 0, strikes: 0 };
      if (report) {
        // Several requests may have already been in flight when GitHub first replied.
        // Escalate once per failed retry window, not once per concurrent reporter.
        if (state.until <= now) {
          state.strikes = now < state.until + HOUR ? state.strikes + 1 : 1;
        }
        const interval = Number.isFinite(report.fallbackMs)
          ? Math.min(MINUTE, Math.max(0, report.fallbackMs))
          : 0;
        const fallback = interval ? now + interval * 2 ** Math.min(5, Math.max(0, state.strikes - 1)) : 0;
        const until = Math.max(report.until, fallback, state.until);
        if (until > state.until) {
          state.until = until;
          await tx.put(QUOTA_KEY, state);
        }
        return state.until;
      }
      if (state.until > now) return state.until;
      const recent = state.writes.filter((at) => at > now - HOUR);
      const last = recent.at(-1);
      const hourWindow = recent.at(-HOURLY_WRITES);
      const minuteWindow = recent.at(-MINUTE_WRITES);
      const ready = Math.max(
        (last ?? -HOUR) + SECOND,
        (minuteWindow ?? -HOUR) + MINUTE,
        (hourWindow ?? -HOUR) + HOUR,
      );
      if (ready > now) return ready;
      recent.push(now);
      await tx.put(QUOTA_KEY, { ...state, writes: recent });
      return null;
    });
    return Response.json({ retryAt });
  }
}

class Deferred extends Error {
  constructor(message, retryAt, contention = false) {
    super(message);
    this.retryAt = retryAt;
    this.contention = contention;
  }
}

async function budget(env, path, report) {
  // Local recovery fixtures can run without another namespace.
  if (!env.GIT_BUDGET) return report?.until ?? null;
  const stub = env.GIT_BUDGET.getByName(env.GITHUB_REPOSITORY.toLowerCase());
  const response = await stub.fetch('https://internal/' + path, {
    method: path === 'status' ? 'GET' : 'POST',
    body: report ? JSON.stringify(report) : undefined,
  });
  if (!response.ok) throw new Error('Could not check repository write allowance');
  return (await response.json()).retryAt;
}

function retryAfter(value, now) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return now + Math.ceil(Number(value) * 1000);
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? absolute : 0;
}

async function observeLimit(response, env) {
  const now = Date.now();
  const retry = retryAfter(response.headers.get('retry-after'), now);
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
  const reset = exhausted ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0;
  let limited =
    response.status === 429 || (response.status === 403 && exhausted) || (!response.ok && retry > 0);
  if (!limited && (response.status === 403 || response.status === 422)) {
    const details = await response
      .clone()
      .json()
      .catch(() => ({}));
    limited = /rate limit|abuse (?:detection|mechanism)|secondary limit/i.test(
      String(details?.message || ''),
    );
  }
  if (!limited && !(response.ok && exhausted)) return;
  const hint = Math.max(retry, Number.isFinite(reset) ? reset : 0);
  const fallback = hint <= now;
  const until = fallback ? now + MINUTE : Math.ceil(hint);
  const sharedUntil = await budget(env, 'cooldown', { until, fallbackMs: fallback ? MINUTE : 0 });
  if (!response.ok)
    throw new Deferred(
      'GitHub throttled requests (' + response.status + ')',
      Math.max(until, sharedUntil || 0),
    );
}

async function unavailable(env) {
  const until = Date.now() + 5000;
  const sharedUntil = await budget(env, 'cooldown', { until, fallbackMs: 5000 });
  throw new Deferred('GitHub temporarily unavailable', Math.max(until, sharedUntil || 0));
}

// Shared handling also covers the GitHub App's installation lookup and token issuance.
// Only repository content mutations consume the project's rolling write allowance.
export async function githubRequest(env, url, options) {
  const writesContent = options.method === 'PUT';
  const pause = await budget(env, writesContent ? 'reserve' : 'status');
  if (pause != null && (writesContent || pause > Date.now())) {
    throw new Deferred(
      writesContent ? 'Waiting for repository write allowance' : 'GitHub shared cooldown',
      pause,
      writesContent,
    );
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    return unavailable(env);
  }
  await observeLimit(response, env);
  if (response.status >= 500) return unavailable(env);
  if (response.status === 401 || response.status === 403) {
    throw new Deferred('GitHub access denied (' + response.status + ')', Date.now() + 5 * MINUTE);
  }
  return response;
}
