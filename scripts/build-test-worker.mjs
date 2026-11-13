import { build } from 'esbuild';
// Keep coverage of legacy D1 code separate from the production proxy Worker.
await build({ entryPoints: ['worker/index.js'], outfile: 'dist/test-worker/index.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', loader: { '.html': 'text' } });
