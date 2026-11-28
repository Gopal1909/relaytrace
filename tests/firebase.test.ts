import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getApps: vi.fn(() => []), initializeApp: vi.fn(() => ({ name: '[DEFAULT]' })),
  initializeAppCheck: vi.fn(() => ({ app: {} })),
  getAI: vi.fn(() => ({ app: {} })), getToken: vi.fn(async () => ({ token: 'synthetic-token-do-not-return' })),
  writeClipboard: vi.fn(async (_text: string) => {}),
}));
vi.mock('firebase/app', () => ({ getApps: mocks.getApps, initializeApp: mocks.initializeApp, getApp: vi.fn() }));
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: mocks.initializeAppCheck, getToken: mocks.getToken,
  ReCaptchaEnterpriseProvider: class { constructor(public siteKey: string) {} },
}));
vi.mock('firebase/ai', () => ({ getAI: mocks.getAI, GoogleAIBackend: class {} }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal('location', { hostname: 'localhost' });
  vi.stubGlobal('FIREBASE_APPCHECK_DEBUG_TOKEN', undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeClipboard } });
  Object.entries({ API_KEY: 'synthetic', AUTH_DOMAIN: 'example.firebaseapp.com', PROJECT_ID: 'example', STORAGE_BUCKET: 'example.firebasestorage.app', MESSAGING_SENDER_ID: '123', APP_ID: '1:123:web:abc' })
    .forEach(([key, value]) => vi.stubEnv(`VITE_FIREBASE_${key}`, value));
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_FIREBASE_APP_CHECK_DEBUG', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Firebase client initialization', () => {
  it('initializes debug App Check before AI and generates rather than embeds a debug secret', async () => {
    const client = await import('../src/lib/firebase');
    expect(client.appCheckMode).toBe('debug');
    expect((globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN)
      .toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
    expect(mocks.initializeAppCheck).toHaveBeenCalledOnce();
    expect(mocks.initializeAppCheck.mock.invocationCallOrder[0]).toBeLessThan(mocks.getAI.mock.invocationCallOrder[0]);
  });
  it('reports verification without exposing the exchanged attestation token', async () => {
    const client = await import('../src/lib/firebase');
    expect(await client.verifyAppCheck()).toEqual({ verified: true });
    expect(mocks.getToken).toHaveBeenCalledWith(client.appCheck, true);
  });
  it('copies the runtime-only token directly to the local clipboard without returning it', async () => {
    const client = await import('../src/lib/firebase');
    expect(await client.copyAppCheckDebugToken()).toBeUndefined();
    expect(mocks.writeClipboard).toHaveBeenCalledWith((globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN);
  });
});
