import { createCaptureKit, type Implementation } from '@neurocapture/capture-kit';
import { createCameraOwner } from './camera-owner.ts';

/** `?impl=mock|native` overrides the platform default (dev only). */
function preferredImpl(): Implementation | undefined {
  const p = new URLSearchParams(globalThis.location?.search ?? '').get('impl');
  return p === 'mock' || p === 'native' ? p : undefined;
}

export const capture = createCaptureKit(preferredImpl());
export const camera = createCameraOwner(capture.kit);
