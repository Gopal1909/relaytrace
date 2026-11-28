import { loadEnv } from 'vite';

const env = loadEnv('development', process.cwd(), 'VITE_');
const required = ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'STORAGE_BUCKET', 'MESSAGING_SENDER_ID', 'APP_ID'];
const missing = required.filter(key => !env[`VITE_FIREBASE_${key}`]).map(key => `VITE_FIREBASE_${key}`);
if (missing.length) {
  console.error(JSON.stringify({ configurationComplete: false, missing }));
  process.exitCode = 1;
} else {
  const result = await fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(env.VITE_FIREBASE_API_KEY)}`, { signal: AbortSignal.timeout(12000) });
  const body = await result.json();
  console.log(JSON.stringify({ configurationComplete: true, authConfigurationHttp: result.status,
    authError: body.error?.message, localhostAuthorized: body.authorizedDomains?.includes('localhost'),
    note: 'This read-only check does not verify anonymous sign-in, App Check enforcement, cloud inference or on-device inference.' }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
