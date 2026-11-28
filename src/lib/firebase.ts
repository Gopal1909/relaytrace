import { getApp, getApps, initializeApp } from 'firebase/app';
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, GoogleAIBackend } from 'firebase/ai';
import { readFirebaseConfig } from './firebase-config';
import { appCheckPolicy } from './app-check-policy';

// Firebase Web configuration is public client configuration; never log it.
export const firebaseApp = getApps().length ? getApp() : initializeApp(readFirebaseConfig(import.meta.env));
const policy = appCheckPolicy({
  dev: import.meta.env.DEV,
  host: globalThis.location?.hostname ?? '',
  debug: import.meta.env.VITE_FIREBASE_APP_CHECK_DEBUG,
  siteKey: import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY,
});
export const appCheckMode = policy.mode;
let localDebugToken: string | undefined;
if (policy.mode === 'debug') {
  // Runtime-only UUID, persisted only in this tab's session storage. The documented
  // string-token mode lets us transfer it directly to Console via local clipboard.
  localDebugToken = globalThis.sessionStorage?.getItem('relaytrace.appCheckDebugToken') || crypto.randomUUID();
  globalThis.sessionStorage?.setItem('relaytrace.appCheckDebugToken', localDebugToken);
  (globalThis as typeof globalThis & { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = localDebugToken;
}
export async function copyAppCheckDebugToken(): Promise<void> {
  if (policy.mode !== 'debug' || !localDebugToken) throw new Error('Debug token copying is restricted to local development.');
  await navigator.clipboard.writeText(localDebugToken);
}
export const appCheck = policy.mode === 'unconfigured' ? null : initializeAppCheck(firebaseApp, {
  // Debug mode intercepts attestation; this sentinel must never be used in production.
  provider: new ReCaptchaEnterpriseProvider(policy.mode === 'enterprise' ? policy.siteKey : 'local-debug-only'),
  isTokenAutoRefreshEnabled: policy.mode === 'enterprise',
});
// App Check must be initialized before the AI service subscribes to its provider.
export const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });

export async function verifyAppCheck(): Promise<{ verified: true }> {
  if (!appCheck) throw new Error('App Check is not configured. See docs/firebase-console.md.');
  await getToken(appCheck, true);
  return { verified: true }; // Never expose the attestation token to UI, logs or reports.
}
