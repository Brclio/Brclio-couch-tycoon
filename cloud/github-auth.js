import { githubRequest } from './git-budget.js';

const enc = new TextEncoder();
const b64url = (bytes) =>
  btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
const ghHeaders = {
  'User-Agent': 'party-tycoon-storage',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
const sessions = new Map();
async function issue(env) {
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  if (!pem || !env.GITHUB_APP_CLIENT_ID) throw Error('GitHub App credentials are not configured');
  const raw = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    { alg: 'RS256', typ: 'JWT' },
    { iat: now - 60, exp: now + 480, iss: env.GITHUB_APP_CLIENT_ID },
  ]
    .map((x) => b64url(enc.encode(JSON.stringify(x))))
    .join('.');
  const jwt =
    parts +
    '.' +
    b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(parts))));
  const headers = { ...ghHeaders, Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' };
  const root = 'https://api.github.com';
  const install = await githubRequest(env, root + '/repos/' + env.GITHUB_REPOSITORY + '/installation', {
    headers,
    signal: AbortSignal.timeout(12000),
  });
  if (!install.ok) throw Error('GitHub App repository installation unavailable (' + install.status + ')');
  const { id } = await install.json();
  const r = await githubRequest(env, root + '/app/installations/' + id + '/access_tokens', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      repositories: [env.GITHUB_REPOSITORY.split('/')[1]],
      permissions: { contents: 'write' },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw Error('Cannot issue repository installation token (' + r.status + ')');
  const { token, expires_at } = await r.json();
  return { token, expires: Date.parse(expires_at) };
}
export async function repositoryToken(env) {
  const target = env.GITHUB_APP_CLIENT_ID + ':' + env.GITHUB_REPOSITORY;
  const cached = sessions.get(target);
  if (cached?.expires > Date.now() + 60000) return cached.token;
  if (cached?.pending) return cached.pending;
  const pending = issue(env)
    .then((value) => {
      sessions.set(target, value);
      return value.token;
    })
    .catch((err) => {
      sessions.delete(target);
      throw err;
    });
  sessions.set(target, { pending });
  return pending;
}
