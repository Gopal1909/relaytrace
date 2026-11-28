import { InferenceMode, type HybridParams } from 'firebase/ai';
import { capsuleResponseSchema } from './capsule';

export function localModelParams(structured = false, signal?: AbortSignal): HybridParams {
  return {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        ...(signal ? { signal } : {}),
      },
      ...(structured ? { promptOptions: { responseConstraint: capsuleResponseSchema } } : {}),
    },
  };
}

export function requireOnDevice(source: unknown): asserts source is 'on_device' {
  if (source !== 'on_device') throw new Error('Expected on-device inference; refusing unverified or cloud output.');
}
