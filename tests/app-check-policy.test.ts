import { describe, expect, it } from 'vitest';
import { appCheckPolicy } from '../src/lib/app-check-policy';

describe('App Check environment policy', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'allows generated debug tokens only in opt-in development on %s', host => {
      expect(appCheckPolicy({ dev: true, host, debug: 'true' })).toEqual({ mode: 'debug' });
    },
  );
  it.each([
    { dev: false, host: 'localhost', debug: 'true' },
    { dev: true, host: 'public.example', debug: 'true' },
    { dev: true, host: 'localhost', debug: 'false' },
  ])('does not enable a debug bypass outside allowed conditions: %j', input => {
    expect(appCheckPolicy(input)).toEqual({ mode: 'unconfigured' });
  });
  it('uses Enterprise attestation with an explicitly configured public site key', () => {
    expect(appCheckPolicy({ dev: false, host: 'public.example', siteKey: 'public-site-key' }))
      .toEqual({ mode: 'enterprise', siteKey: 'public-site-key' });
  });
});
