import type { FirebaseOptions } from 'firebase/app';

const fields = {
  apiKey: 'VITE_FIREBASE_API_KEY',
  authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  projectId: 'VITE_FIREBASE_PROJECT_ID',
  storageBucket: 'VITE_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID',
  appId: 'VITE_FIREBASE_APP_ID',
} as const;

export function readFirebaseConfig(env: Record<string, unknown>): FirebaseOptions {
  const missing = Object.values(fields).filter(key =>
    typeof env[key] !== 'string' || !(env[key] as string).trim(),
  );
  if (missing.length) throw new Error(`Missing Firebase environment variables: ${missing.join(', ')}`);
  return Object.fromEntries(Object.entries(fields).map(([field, key]) =>
    [field, (env[key] as string).trim()],
  ));
}
