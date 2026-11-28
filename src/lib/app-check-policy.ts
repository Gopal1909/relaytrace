type Settings = { dev: boolean; host: string; debug?: string; siteKey?: string };
type Policy = { mode: 'debug' } | { mode: 'enterprise'; siteKey: string } | { mode: 'unconfigured' };

export function appCheckPolicy({ dev, host, debug, siteKey }: Settings): Policy {
  if (dev && ['localhost', '127.0.0.1', '[::1]'].includes(host) && debug === 'true') {
    return { mode: 'debug' };
  }
  if (siteKey?.trim()) return { mode: 'enterprise', siteKey: siteKey.trim() };
  return { mode: 'unconfigured' };
}
