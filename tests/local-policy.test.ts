import { describe, expect, it } from 'vitest';
import { InferenceMode } from 'firebase/ai';
import { localModelParams, requireOnDevice } from '../src/ai/local-policy';

describe('private extraction policy', () => {
  it('uses strict local-only inference, never a silent cloud fallback', () => {
    expect(localModelParams().mode).toBe(InferenceMode.ONLY_ON_DEVICE);
  });
  it('passes the capsule response constraint to the on-device model, not a cloud generation config', () => {
    const params = localModelParams(true);
    expect(params.mode).toBe(InferenceMode.ONLY_ON_DEVICE);
    expect(params.onDeviceParams?.promptOptions?.responseConstraint).toBeDefined();
    expect(params.inCloudParams).toBeUndefined();
  });
  it('requests an English text-only session and forwards the lifetime cancellation signal', () => {
    const controller = new AbortController();
    const options = localModelParams(false, controller.signal).onDeviceParams?.createOptions;
    expect(options?.expectedInputs).toEqual([{ type: 'text', languages: ['en'] }]);
    expect(options?.expectedOutputs).toEqual([{ type: 'text', languages: ['en'] }]);
    expect(options?.signal).toBe(controller.signal);
  });
  it('accepts only actual SDK on-device provenance', () => {
    expect(() => requireOnDevice('on_device')).not.toThrow();
    expect(() => requireOnDevice('in_cloud')).toThrow('Expected on-device inference');
    expect(() => requireOnDevice(undefined)).toThrow('Expected on-device inference');
  });
});
