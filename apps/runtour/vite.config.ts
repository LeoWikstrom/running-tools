/// <reference types="vitest/config" />
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * In production the app sits beside the Pages site, so `../gtfs/<feed>.json`
 * resolves to site/gtfs. The dev server serves only the app root — this
 * mirrors the deployed layout so the GTFS path works locally too.
 */
function serveSiteGtfs(): Plugin {
  return {
    name: 'serve-site-gtfs',
    configureServer(server) {
      server.middlewares.use('/gtfs', (req, res, next) => {
        void (async () => {
          const name = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
          if (!/^[\w-]+\.json$/.test(name)) return next();
          try {
            const body = await readFile(
              fileURLToPath(new URL(`../../site/gtfs/${name}`, import.meta.url)),
            );
            res.setHeader('Content-Type', 'application/json');
            res.end(body);
          } catch {
            res.statusCode = 404;
            res.end();
          }
        })();
      });
    },
  };
}

/**
 * Dev-only remote console: the phone browser's errors and rejections land in
 * the vite terminal, since there is no devtools access to it from Termux.
 */
function errorBeacon(): Plugin {
  return {
    name: 'error-beacon',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__beacon', (req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          console.error(`[beacon] ${body}`);
          res.end('ok');
        });
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          injectTo: 'head-prepend',
          children: `
            const post = (msg) => fetch('/__beacon', { method: 'POST', body: msg }).catch(() => {});
            window.addEventListener('error', (e) =>
              post('error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno + '\\n' + (e.error?.stack ?? '')));
            window.addEventListener('unhandledrejection', (e) =>
              post('rejection: ' + (e.reason?.stack ?? String(e.reason))));
          `,
        },
      ];
    },
  };
}

export default defineConfig({
  // Android/Termux inotify is unreliable, so the dev server silently served
  // stale modules after edits; polling actually sees the changes.
  server: { watch: { usePolling: true, interval: 500 } },
  base: './',
  build: { target: 'es2022' },
  plugins: [serveSiteGtfs(), errorBeacon()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
