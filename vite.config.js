import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 8080,
    hmr: false
  },
  build: {
    outDir: 'dist'
  }
});
