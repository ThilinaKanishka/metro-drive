import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { open: false },
  build: {
    target: 'es2022', // top-level await (asset loading in main.js)
    chunkSizeWarningLimit: 1200,
  },
});
