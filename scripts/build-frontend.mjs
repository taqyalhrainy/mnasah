import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { FRONTEND_ORIGIN, BACKEND_ORIGIN } from '../shared/deployment.js';

const check = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);
await build({ define: {
  'import.meta.env.VITE_API_URL': JSON.stringify(process.env.GITHUB_PAGES ? BACKEND_ORIGIN : ''),
  'import.meta.env.VITE_EDGE_FRONTEND': 'true',
} });
const index = 'dist/client/index.html';
await writeFile(index, (await readFile(index, 'utf8')).replaceAll(BACKEND_ORIGIN, FRONTEND_ORIGIN));
for (const name of ['robots.txt', 'sitemap.xml', 'about/index.html']) {
  const file = `dist/client/${name}`;
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll(BACKEND_ORIGIN, FRONTEND_ORIGIN));
}
await import('./build-worker.mjs');
