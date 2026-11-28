import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildServiceWorker, buildCacheVersion } from './scripts/offline-shell.mjs';
export default defineConfig({
  build: { rollupOptions: { input: {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    verification: fileURLToPath(new URL('./firebase-check.html', import.meta.url)),
    reliability: fileURLToPath(new URL('./firebase-reliability.html', import.meta.url)),
    native: fileURLToPath(new URL('./native-probe.html', import.meta.url)),
  } } },
  plugins: [tailwindcss(), {
    name: 'relaytrace-offline-shell',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(name => /\.(js|css|svg|png|woff2?)$/.test(name)).map(name => '/' + name);
      const html = ['index.html', 'firebase-check.html', 'firebase-reliability.html', 'native-probe.html'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8'));
      const version = buildCacheVersion(assets, html);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: buildServiceWorker(['/index.html', '/firebase-check.html', '/firebase-reliability.html', '/native-probe.html', ...assets], version) });
    },
  }],
});
