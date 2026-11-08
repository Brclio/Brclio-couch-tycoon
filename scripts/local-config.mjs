import { readFile, writeFile } from 'node:fs/promises';

// Wrangler infers a local request's Host from production routes. Local rooms must
// invite players back to the address and port they actually opened in the browser.
const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('wrangler.jsonc', root), 'utf8'));
delete config.routes;
await writeFile(new URL('.wrangler-local.json', root), JSON.stringify(config, null, 2));
