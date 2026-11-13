import { mkdir, cp } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await build({ entryPoints: ['worker/index.js'], outfile: 'dist/server/index.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', loader: { '.html': 'text' } });
try {
  await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}
await cp('drizzle', 'dist/.openai/drizzle', { recursive: true });
