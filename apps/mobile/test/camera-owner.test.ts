import { describe, expect, it } from 'vitest';
import { MockCaptureKit, sampleFixtures, type OpenCameraOpts } from '@neurocapture/capture-kit';
import { createCameraOwner } from '../src/lib/camera-owner.ts';

const opts: OpenCameraOpts = {
  facing: 'back',
  resolution: '1080p',
  targetFps: 60,
  orientation: 'portrait',
  trackers: ['hand'],
  analysisFps: 30,
};

describe('createCameraOwner', () => {
  it('survives the StrictMode mount → unmount → mount sequence without "camera already open"', async () => {
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    const owner = createCameraOwner(kit);
    // Fired synchronously, exactly like React's dev double-invoke of an effect.
    const first = owner.open(opts);
    const close = owner.close();
    const second = owner.open(opts);
    await expect(first).resolves.toBeDefined();
    await expect(close).resolves.toBeUndefined();
    await expect(second).resolves.toBeDefined();
    await owner.close();
  });

  it('keeps the queue going after a failure', async () => {
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    const owner = createCameraOwner(kit);
    await owner.open(opts);
    await expect(owner.open(opts)).rejects.toThrow(/already open/);
    await expect(owner.close()).resolves.toBeUndefined();
    await expect(owner.open(opts)).resolves.toBeDefined();
    await owner.close();
  });
});
