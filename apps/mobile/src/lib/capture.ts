import { createCaptureKit, type Implementation } from '@neurocapture/capture-kit';
import { createCameraOwner } from './camera-owner.ts';

const params = new URLSearchParams(globalThis.location?.search ?? '');

/** `?impl=mock|webcam|native` overrides the platform default (dev only). */
function preferredImpl(): Implementation | undefined {
  const p = params.get('impl');
  return p === 'mock' || p === 'webcam' || p === 'native' ? p : undefined;
}

/** `?mockSpeed=20` speeds up mock recordings and UI countdowns (development and e2e only). */
const requested = Number(params.get('mockSpeed') ?? '1');
export const capture = createCaptureKit(preferredImpl(), { speed: requested > 0 ? requested : 1 });
export const clockSpeed = capture.implementation === 'mock' && requested > 0 ? requested : 1;
export const camera = createCameraOwner(capture.kit);
