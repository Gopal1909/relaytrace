import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildServiceWorker, buildCacheVersion } from '../scripts/offline-shell.mjs';
it('invalidates the offline build cache when entry HTML changes without changing asset filenames', () => {
  const assets = ['/assets/app-stable.js'];
  expect(buildCacheVersion(assets, ['<title>Old</title>'])).not.toBe(buildCacheVersion(assets, ['<title>New</title>']));
  expect(buildCacheVersion(assets, ['<title>New</title>'])).toBe(buildCacheVersion(assets, ['<title>New</title>']));
});
it('never intercepts Firebase requests or arbitrary local private URLs', () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  runInNewContext(buildServiceWorker(['/assets/app.js', '/index.html'], 'test'), {
    self: { location: { origin: 'https://relaytrace.test' }, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; } },
    URL, caches: {}, fetch: vi.fn(),
  });
  for (const url of ['https://firebaseappcheck.googleapis.com/token', 'https://relaytrace.test/private-content']) {
    const respondWith = vi.fn(); handlers.fetch({ request: { method: 'GET', url, mode: 'cors' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  }
});
it('matches immutable assets despite server Vary: Origin differences between precache and module requests', async () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const asset = { body: 'immutable app bundle' }; let response: Promise<unknown> | undefined;
  runInNewContext(buildServiceWorker(['/assets/app.js'], 'test'), {
    self: { location: { origin: 'https://relaytrace.test' }, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; } },
    URL, caches: { match: async (_r: unknown, options?: { ignoreVary?: boolean }) => options?.ignoreVary ? asset : undefined }, fetch: vi.fn(async () => { throw new Error('offline'); }), Response,
  });
  handlers.fetch({ request: { method: 'GET', url: 'https://relaytrace.test/assets/app.js', mode: 'cors', cache: 'default', headers: new Headers({ Origin: 'https://relaytrace.test' }) }, respondWith: (p: Promise<unknown>) => { response = p; } });
  await expect(response).resolves.toBe(asset);
});

it('serves the cached shell when a genuine navigation fetch fails', async () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shell = { body: 'cached shell' }; let response: Promise<unknown> | undefined;
  runInNewContext(buildServiceWorker(['/index.html'], 'test'), {
    self: { location: { origin: 'https://relaytrace.test' }, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; } },
    URL, caches: { match: async () => shell }, fetch: vi.fn(async () => { throw new Error('offline'); }), Response,
  });
  handlers.fetch({ request: { method: 'GET', url: 'https://relaytrace.test/project/synthetic', mode: 'navigate', cache: 'reload' }, respondWith: (p: Promise<unknown>) => { response = p; } });
  await expect(response).resolves.toBe(shell);
});
