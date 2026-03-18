import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty', 'ws', 'bufferutil', 'utf-8-validate'],
    },
  },
});
