import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { LocalInferenceControls, LocalLatencyPanel } from '../src/ui/LocalInferenceControls';
it('exposes explicit warmup and idle release without calling them on render', () => {
  const prepare = vi.fn(); const release = vi.fn();
  const html = renderToStaticMarkup(createElement(LocalInferenceControls, { busy: false, preparing: false, onPrepare: prepare, onRelease: release }));
  expect(html).toContain('Prepare on-device AI'); expect(html).toContain('Release idle model');
  expect(html).toContain('synthetic'); expect(html).toContain('No notes or photos');
  expect(prepare).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
});
it('shows first-chunk measurements as SDK timing, not a guaranteed native token latency', () => {
  const html = renderToStaticMarkup(createElement(LocalLatencyPanel, { metrics: { operation: 'extraction', status: 'passed', modelReused: true, initializationMs: 0, firstChunkLatencyMs: 477.2, generationMs: 565.3, totalMs: 565.3 } }));
  expect(html).toContain('477 ms'); expect(html).toContain('565 ms'); expect(html).toContain('Warm SDK instance reused');
  expect(html).toContain('includes session creation');
});
it('does not invent a first chunk for timed-out requests', () => {
  const html = renderToStaticMarkup(createElement(LocalLatencyPanel, { metrics: { operation: 'extraction', status: 'timed_out', modelReused: false, initializationMs: 10, firstChunkLatencyMs: null, generationMs: 180000, totalMs: 180010, interruptedStage: 'generating' } }));
  expect(html).toContain('No text chunk received'); expect(html).toContain('timed_out');
  expect(html).not.toContain('ON DEVICE — VERIFIED');
});
