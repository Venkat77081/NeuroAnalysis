import type { CaptureKitPlugin, OpenCameraOpts } from '@neurocapture/capture-kit';

/**
 * Serializes camera open/close so overlapping callers (React StrictMode double-mount in dev,
 * fast screen changes) never race: each call waits for the previous one to settle.
 */
export function createCameraOwner(kit: CaptureKitPlugin) {
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };
  return {
    open: (opts: OpenCameraOpts) => run(() => kit.openCamera(opts)),
    close: () => run(() => kit.closeCamera()),
  };
}
