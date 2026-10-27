/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Android/Termux inotify is unreliable, so the dev server silently served
  // stale modules after edits; polling actually sees the changes.
  server: { watch: { usePolling: true, interval: 500 } },
  base: './',
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
