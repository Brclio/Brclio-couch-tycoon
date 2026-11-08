import { cp, mkdir, rm } from 'node:fs/promises';
const out = new URL('../.web-assets/', import.meta.url);
await rm(out, { force: true, recursive: true });
await mkdir(out, { recursive: true });
await cp(new URL('../public/', import.meta.url), out, { recursive: true });
await cp(new URL('../shared/', import.meta.url), new URL('shared/', out), { recursive: true });
