/**
 * M13: reading the invite QR code with the phone camera, inside the app. Uses the platform's
 * BarcodeDetector when it has one, otherwise jsQR (pure JS). Frames are decoded in memory and
 * never stored.
 */
import jsQR from 'jsqr';

/** Decodes one RGBA frame; null if no QR code is found. */
export function decodeQrFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  return jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

export function nativeDetector(): Detector | null {
  const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector })
    .BarcodeDetector;
  try {
    return BD ? new BD({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

/** Reads frames from `video` until a QR code is found; `stop()` ends it. */
export function scanVideo(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  intervalMs = 200,
): { stop: () => void } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const detector = nativeDetector();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (stopped) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h && ctx) {
      let text: string | null = null;
      if (detector) {
        try {
          text = (await detector.detect(video))[0]?.rawValue ?? null;
        } catch {
          text = null;
        }
      }
      if (!text) {
        const scale = Math.min(1, 640 / Math.max(w, h));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        text = decodeQrFrame(img.data, img.width, img.height);
      }
      if (text && !stopped) {
        stopped = true;
        onResult(text);
        return;
      }
    }
    timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
