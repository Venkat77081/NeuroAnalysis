import { Capacitor, registerPlugin } from '@capacitor/core';
import type { CaptureKitPlugin, Implementation } from './definitions.ts';
import { MockCaptureKit, scaledScheduler } from './mock.ts';
import type { CaptureFixture } from './fixture.ts';
import ftRSample from '../fixtures/ft-r-sample.json' with { type: 'json' };

export * from './definitions.ts';
export type { CaptureFixture } from './fixture.ts';
export { MockCaptureKit, scaledScheduler, type MockOptions, type Scheduler } from './mock.ts';
export { encodeFloat32, decodeFloat32, bytesToBase64, base64ToBytes } from './codec.ts';
export { PLUGIN_VERSION } from './version.ts';
export * from './streams.ts';
export * from './landmarks.ts';
export * from './frame-math.ts';

export const sampleFixtures = { 'ft-r-sample': ftRSample as CaptureFixture };

/** Native implementation; only valid on a device. Native code arrives in M1 (Android). */
export const NativeCaptureKit = registerPlugin<CaptureKitPlugin>('CaptureKit');

/**
 * Choose the implementation (DEV_PLAN §5.3). Native on a device; mock in the browser.
 * The webcam implementation (Tier W) is added in M4.
 */
export function createCaptureKit(
  preferred?: Implementation,
  mock: { speed?: number } = {},
): { kit: CaptureKitPlugin; implementation: Implementation } {
  const wantNative = preferred ? preferred === 'native' : Capacitor.isNativePlatform();
  if (wantNative) return { kit: NativeCaptureKit, implementation: 'native' };
  if (preferred === 'webcam') {
    // Lazy-loaded so the MediaPipe web bundle is only fetched in webcam demo mode.
    return {
      kit: new LazyWebcam(sampleFixtures['ft-r-sample']) as unknown as CaptureKitPlugin,
      implementation: 'webcam',
    };
  }
  return {
    kit: new MockCaptureKit({
      fixture: sampleFixtures['ft-r-sample'],
      scheduler: scaledScheduler(mock.speed ?? 1),
    }),
    implementation: 'mock',
  };
}

/** Proxy that loads webcam.ts (and MediaPipe) on first use. */
class LazyWebcam {
  private impl: Promise<CaptureKitPlugin>;
  constructor(fixture: CaptureFixture) {
    this.impl = import('./webcam.ts').then(
      (m) => new m.WebcamCaptureKit({ fixture }) as CaptureKitPlugin,
    );
    return new Proxy(this, {
      get:
        (_t, prop: string) =>
        (...args: unknown[]) =>
          this.impl.then((k) =>
            (k as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]!(...args),
          ),
    });
  }
}
