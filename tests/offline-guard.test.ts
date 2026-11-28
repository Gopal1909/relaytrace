import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  updates: [] as unknown[],
  initialize: vi.fn(),
  generate: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('react', () => ({
  useEffect: () => {},
  useState: (initial: unknown) => [initial, (value: unknown) => {
    if (initial && typeof initial === 'object' && 'status' in initial) mocks.updates.push(value);
  }],
}));
vi.mock('../src/lib/firebase', () => ({ ai: {}, appCheckMode: 'off' }));
vi.mock('firebase/ai', async importOriginal => ({
  ...await importOriginal<typeof import('firebase/ai')>(),
  getGenerativeModel: mocks.construct,
}));
import { App } from '../src/App';

let network: { onLine: boolean };
let events: EventTarget;
let add: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
const changedMessage = 'Networking changed during the test; offline inference is not verified.';

function startOffline() {
  const findButton = (node: unknown): (() => Promise<void>) | undefined => {
    if (!node || typeof node !== 'object') return;
    const element = node as ReactElement<{ children?: unknown; onClick?: () => Promise<void> }>;
    if (element.type === 'button' && element.props.children === 'Run offline structured extraction') return element.props.onClick;
    for (const child of [element.props?.children].flat(Infinity)) {
      const found = findButton(child);
      if (found) return found;
    }
  };
  const click = findButton(App());
  expect(click).toBeTypeOf('function');
  return click!();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates.length = 0;
  network = { onLine: false };
  events = new EventTarget();
  add = vi.fn(events.addEventListener.bind(events));
  remove = vi.fn(events.removeEventListener.bind(events));
  vi.stubGlobal('navigator', network);
  vi.stubGlobal('addEventListener', add);
  vi.stubGlobal('removeEventListener', remove);
  mocks.construct.mockReturnValue({ initializeDeviceModel: mocks.initialize, generateContent: mocks.generate });
  mocks.initialize.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({ response: {
    inferenceSource: 'on_device',
    text: () => JSON.stringify({ observation: [], attempted: [], changed: [], result: [], unresolved: [], next_check: [] }),
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('offline feasibility continuity through the actual button handler', () => {
  it('rejects offline → online → offline while initialization is pending', async () => {
    let finish!: () => void;
    mocks.initialize.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = startOffline();
    expect(mocks.initialize).toHaveBeenCalledOnce(); // Still inside the original button gesture.
    network.onLine = true;
    events.dispatchEvent(new Event('online'));
    network.onLine = false;
    events.dispatchEvent(new Event('offline'));
    finish();
    await pending;
    expect(mocks.updates.at(-1)).toEqual({ status: 'failed', error: changedMessage });
  });

  it('passes normal offline extraction and removes its listener', async () => {
    mocks.initialize.mockImplementationOnce(() => {
      expect(add).toHaveBeenCalledWith('online', expect.any(Function));
      return Promise.resolve();
    });
    const pending = startOffline();
    expect(mocks.initialize).toHaveBeenCalledOnce();
    await pending;
    expect(mocks.updates.at(-1)).toMatchObject({ status: 'passed', source: 'on_device' });
    expect(remove).toHaveBeenCalledExactlyOnceWith('online', add.mock.calls[0][1]);
  });

  it('does not construct or initialize a model when initially online', async () => {
    network.onLine = true;
    await startOffline();
    expect(mocks.updates.at(-1)).toEqual({
      status: 'failed',
      error: 'Disable networking for this browser tab before the offline test. No offline state is simulated by this app.',
    });
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects a final online state even without an online event', async () => {
    mocks.generate.mockImplementationOnce(async () => {
      network.onLine = true;
      return { response: { inferenceSource: 'on_device', text: () => JSON.stringify({ observation: [], attempted: [], changed: [], result: [], unresolved: [], next_check: [] }) } };
    });
    await startOffline();
    expect(mocks.updates.at(-1)).toEqual({ status: 'failed', error: changedMessage });
    expect(remove).toHaveBeenCalledExactlyOnceWith('online', add.mock.calls[0][1]);
  });

  it('keeps monitoring through response validation and capsule parsing', async () => {
    mocks.generate.mockResolvedValueOnce({ response: {
      inferenceSource: 'on_device',
      text: () => {
        events.dispatchEvent(new Event('online')); // Latch the event even if the state is already offline again.
        return JSON.stringify({ observation: [], attempted: [], changed: [], result: [], unresolved: [], next_check: [] });
      },
    } });
    await startOffline();
    expect(mocks.updates.at(-1)).toEqual({ status: 'failed', error: changedMessage });
    expect(remove).toHaveBeenCalledExactlyOnceWith('online', add.mock.calls[0][1]);
  });

  it.each(['construction', 'initialization', 'generation', 'source validation', 'capsule parsing'])('removes its listener after an error in %s', async stage => {
    const error = new Error('Synthetic operation failure');
    if (stage === 'construction') mocks.construct.mockImplementationOnce(() => { throw error; });
    if (stage === 'initialization') mocks.initialize.mockRejectedValueOnce(error);
    if (stage === 'generation') mocks.generate.mockRejectedValueOnce(error);
    if (stage === 'source validation') mocks.generate.mockResolvedValueOnce({ response: { inferenceSource: 'in_cloud' } });
    if (stage === 'capsule parsing') mocks.generate.mockResolvedValueOnce({ response: { inferenceSource: 'on_device', text: () => '{}' } });
    await startOffline();
    expect(mocks.updates.at(-1)).toMatchObject({ status: 'failed' });
    expect(remove).toHaveBeenCalledExactlyOnceWith('online', add.mock.calls[0][1]);
  });
});
