import { describe, it, expect } from 'vitest';
import { readFirebaseConfig } from '../src/lib/firebase-config';

const valid = {
  VITE_FIREBASE_API_KEY: 'test-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'example',
  VITE_FIREBASE_STORAGE_BUCKET: 'example.firebasestorage.app',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789',
  VITE_FIREBASE_APP_ID: '1:123456789:web:abcdef',
};

describe('Firebase environment configuration', () => {
  it('maps the Vite environment into Firebase options', () => {
    expect(readFirebaseConfig(valid)).toEqual({
      apiKey: valid.VITE_FIREBASE_API_KEY,
      authDomain: valid.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: valid.VITE_FIREBASE_PROJECT_ID,
      storageBucket: valid.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: valid.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: valid.VITE_FIREBASE_APP_ID,
    });
  });
  it('reports missing variable names without leaking supplied values', () => {
    expect(() => readFirebaseConfig({ ...valid, VITE_FIREBASE_API_KEY: '' }))
      .toThrow('Missing Firebase environment variables: VITE_FIREBASE_API_KEY');
  });
});
