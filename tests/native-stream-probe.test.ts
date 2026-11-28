import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
it('uses native default options, streams the minimal prompt, measures first chunk and destroys the session', async () => {
  vi.useFakeTimers();
  let clock = 0;
  const nodes = new Map<string, Record<string, unknown>>();
  const node = (key: string) => { if (!nodes.has(key)) nodes.set(key, { textContent: '', disabled: false }); return nodes.get(key)!; };
  let reads = 0;
  const session = {
    destroy: vi.fn(),
    prompt: vi.fn(() => { throw new Error('Non-streaming inference must not be used'); }),
    promptStreaming: vi.fn(() => ({ getReader: () => ({ read: async () => {
      clock = reads++ === 0 ? 6000 : 6100;
      return reads === 1 ? { value: 'OK', done: false } : { done: true };
    }, releaseLock: vi.fn() }) })),
  };
  const create = vi.fn(async () => { clock = 1000; return session; });
  const html = readFileSync(new URL('../native-probe.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
  await runInNewContext(`${script}\nrun('defaults');`, {
    document: { querySelector: node, visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
    navigator: { userActivation: { isActive: true } },
    LanguageModel: { availability: vi.fn(async () => 'available'), create },
    performance: { now: () => clock }, Date, AbortController, Error, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const report = JSON.parse(String(node('#result').textContent));
  expect(report.status).toBe('passed');
  expect(Object.keys(create.mock.calls[0][0])).toEqual(['signal']);
  expect(session.prompt).not.toHaveBeenCalled();
  expect(session.promptStreaming.mock.calls[0][0]).toBe('Say OK.');
  expect(report.timeoutMs).toBe(180000);
  expect(report.createMs).toBe(1000);
  expect(report.firstChunkLatencyMs).toBe(5000);
  expect(report.elapsedMs).toBe(6100);
  expect(report.answer).toBe('OK');
  expect(session.destroy).toHaveBeenCalledOnce();
});

it('keeps a pending native create alive until the shared 180-second deadline, then aborts it', async () => {
  vi.useFakeTimers();
  const nodes = new Map<string, Record<string, unknown>>();
  const node = (key: string) => { if (!nodes.has(key)) nodes.set(key, { textContent: '', disabled: false }); return nodes.get(key)!; };
  const create = vi.fn(() => new Promise(() => {}));
  const html = readFileSync(new URL('../native-probe.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
  const task = runInNewContext(`${script}\nrun();`, {
    document: { querySelector: node, visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
    navigator: { userActivation: { isActive: true } }, LanguageModel: { create },
    performance: { now: () => Date.now() }, Date, AbortController, Error, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const signal = create.mock.calls[0][0].signal;
  await vi.advanceTimersByTimeAsync(179999);
  expect(signal.aborted).toBe(false);
  expect(JSON.parse(String(node('#result').textContent)).status).toBe('running');
  await vi.advanceTimersByTimeAsync(1); await task;
  expect(signal.aborted).toBe(true);
  expect(JSON.parse(String(node('#result').textContent))).toMatchObject({ status: 'failed', failedStage: 'create', error: expect.stringContaining('180-second total deadline') });
  expect(vi.getTimerCount()).toBe(0);
});
