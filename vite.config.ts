import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/mnasah/' : '/',
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787' },
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
      },
    },
  },
});
