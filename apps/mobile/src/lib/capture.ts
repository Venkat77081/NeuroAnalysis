import { createCaptureKit, type Implementation } from '@neurocapture/capture-kit';

/** `?impl=mock|native` overrides the platform default (dev only). */
function preferredImpl(): Implementation | undefined {
  const p = new URLSearchParams(globalThis.location?.search ?? '').get('impl');
  return p === 'mock' || p === 'native' ? p : undefined;
}

export const capture = createCaptureKit(preferredImpl());
