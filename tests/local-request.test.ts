import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({ updates: [] as unknown[], construct: vi.fn(), initialize: vi.fn(), generate: vi.fn() }));
vi.mock('react', () => ({
  useEffect: () => {},
  useState: (initial: unknown) => [initial, (value: unknown) => mocks.updates.push(value)],
}));
vi.mock('../src/lib/firebase', () => ({ ai: {}, appCheckMode: 'debug' }));
vi.mock('firebase/ai', async original => ({ ...await original<typeof import('firebase/ai')>(), getGenerativeModel: mocks.construct }));
import { App } from '../src/App';

const work: Promise<unknown>[] = [];
const pending: (() => void)[] = [];
function click(label: string) {
  function find(node: unknown): (() => Promise<void>) | undefined {
    if (!node || typeof node !== 'object') return;
    const e = node as ReactElement<{ children?: unknown; onClick?: () => Promise<void> }>;
    if (e.type === 'button' && e.props.children === label) return e.props.onClick;
    for (const child of [e.props?.children].flat(Infinity)) { const result = find(child); if (result) return result; }
  }
  const action = find(App());
  expect(action).toBeTypeOf('function');
  const promise = action!(); work.push(promise); return promise;
}
function lastResult() {
  return mocks.updates.filter((x): x is { status: string; error?: string } => !!x && typeof x === 'object' && 'status' in x).at(-1);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.updates.length = 0; work.length = 0; pending.length = 0;
  vi.stubGlobal('navigator', { onLine: true });
  mocks.construct.mockReturnValue({ initializeDeviceModel: mocks.initialize, generateContent: mocks.generate });
  mocks.initialize.mockImplementation(() => new Promise<void>(resolve => pending.push(resolve)));
  mocks.generate.mockResolvedValue({ response: { inferenceSource: 'on_device', text: () => 'Synthetic local response' } });
});
afterEach(async () => {
  pending.forEach(resolve => resolve()); await Promise.allSettled(work);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('real inference button lifecycle', () => {
  it('does not leave a never-resolving initialization in the running state forever', async () => {
    click('Run genuine local inference');
    await vi.advanceTimersByTimeAsync(120_001);
    expect(lastResult()).toMatchObject({ status: 'failed', error: expect.stringMatching(/timed out.*initializ/i) });
  });
  it('does not start a second SDK model from another inference button while one is pending', () => {
    click('Run genuine local inference'); click('Run structured local extraction');
    expect(mocks.construct).toHaveBeenCalledTimes(1);
  });
  it('passes a lifetime AbortSignal to the real SDK model creation options', () => {
    click('Run genuine local inference');
    const params = mocks.construct.mock.calls[0][1];
    expect(params.onDeviceParams?.createOptions?.signal).toBeInstanceOf(AbortSignal);
  });
  it('distinguishes initialization from generation in progress events', () => {
    click('Run genuine local inference');
    expect(mocks.updates.some(x => !!x && typeof x === 'object' && 'phase' in x && x.phase === 'initializing')).toBe(true);
  });
});
