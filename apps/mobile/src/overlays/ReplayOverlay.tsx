import { useEffect, useRef, useState } from 'react';
import {
  base64ToBytes,
  decodeAnalysisFrame,
  decodeLandmarks,
  eventFromRecord,
} from '@neurocapture/capture-kit';
import type { LandmarkFrame } from '@neurocapture/quality-core';
import { capture } from '../lib/capture.ts';
import { logger } from '../lib/logger.ts';
import { drawLandmarks, fitCanvas } from './draw.ts';
import { containTransform, nearestIndex } from './landmark-geometry.ts';

/**
 * Landmarks of a recorded take drawn over its video during replay. Video time τ maps to the
 * canonical clock as firstSampleNs + τ (RecordingResult.mp4.firstSampleNs); the nearest
 * landmarks.bin record within half a frame period is drawn.
 */
export function ReplayOverlay({
  takeId,
  firstSampleNs,
  video,
}: {
  takeId: string;
  firstSampleNs: string | null;
  video: React.RefObject<HTMLVideoElement | null>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<LandmarkFrame[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    capture.kit.readLandmarks({ takeId }).then(
      ({ data }) => {
        if (cancelled) return;
        if (!data) return setFrames([]);
        const { records } = decodeLandmarks(base64ToBytes(data));
        setFrames(records.map((r) => decodeAnalysisFrame(eventFromRecord(r, 0, 0))));
      },
      (e: unknown) => {
        logger.warn('readLandmarks failed', { error: String(e) });
        if (!cancelled) setFrames([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [takeId]);

  useEffect(() => {
    if (!frames?.length || firstSampleNs === null) return;
    const times = frames.map((f) => f.tNs);
    const start = BigInt(firstSampleNs);
    const halfPeriod =
      times.length > 1 ? (times.at(-1)! - times[0]!) / BigInt(2 * (times.length - 1)) : 0n;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      const v = video.current;
      if (!c || !v) return;
      const g = fitCanvas(c, c.clientWidth, c.clientHeight);
      if (!g || !v.videoWidth) return;
      const t = start + BigInt(Math.round(v.currentTime * 1e9));
      const i = nearestIndex(times, t);
      const f = frames[i];
      if (!f) return;
      const dt = f.tNs > t ? f.tNs - t : t - f.tNs;
      if (halfPeriod > 0n && dt > 2n * halfPeriod) return; // no record near this video time
      drawLandmarks(
        g,
        f,
        containTransform(v.videoWidth, v.videoHeight, c.clientWidth, c.clientHeight),
      );
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frames, firstSampleNs, video]);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-testid="replay-overlay"
      data-frames={frames?.length ?? ''}
      aria-hidden="true"
    />
  );
}
