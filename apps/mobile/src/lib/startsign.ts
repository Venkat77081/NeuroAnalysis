/**
 * v36 (decision 063): patients start a recording with a sign (open palm; raised arm for Stand and
 * Walk) instead of tapping Record. Patients only; only when this phone's check saw the sign and
 * tracked fast enough; the patient can switch it off in Settings. The Record button always stays.
 *
 * Both values are kept on this phone only (they describe the phone and a preference, not the patient).
 */
import { useEffect, useRef, useState } from 'react';
import { decodeAnalysisFrame, type AnalysisFrameEvent } from '@neurocapture/capture-kit';
import {
  findSign,
  StartSignTracker,
  type StartSignConfig,
  type StartSignKind,
} from '@neurocapture/quality-core';
import { capture } from './capture.ts';

/** works = seen at the phone check; too_slow = tracking under the minimum; not_seen; skipped. */
export type SignCheck = 'works' | 'too_slow' | 'not_seen' | 'skipped';

const CHECK_KEY = 'nc.startSign.check';
const OFF_KEY = 'nc.startSign.off';

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, v: string | null): void {
  try {
    if (v === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, v);
  } catch {
    /* storage unavailable: the sign is simply not offered */
  }
}

export function signCheck(): SignCheck | null {
  const v = read(CHECK_KEY);
  return v === 'works' || v === 'too_slow' || v === 'not_seen' || v === 'skipped' ? v : null;
}
export function saveSignCheck(v: SignCheck): void {
  write(CHECK_KEY, v);
}
/** The patient's own switch in Settings (on unless switched off). */
export function signWanted(): boolean {
  return read(OFF_KEY) !== '1';
}
export function setSignWanted(on: boolean): void {
  write(OFF_KEY, on ? null : '1');
}

/**
 * Watches the analysis frames for the sign while `active`. Returns the hold progress (0–1);
 * `onFire` runs once per raise. Updates the progress at most every 100 ms.
 */
export function useStartSign(
  active: boolean,
  kind: StartSignKind,
  cfg: StartSignConfig,
  onFire: () => void,
): number {
  const [progress, setProgress] = useState(0);
  const fire = useRef(onFire);
  useEffect(() => {
    fire.current = onFire;
  });
  useEffect(() => {
    if (!active) return;
    const tracker = new StartSignTracker(cfg);
    let shown = 0;
    let lastPush = 0;
    const handle = capture.kit.addListener('analysisFrame', (e: AnalysisFrameEvent) => {
      const frame = decodeAnalysisFrame(e);
      const tS = Number(frame.tNs) / 1e9;
      const s = tracker.update(tS, findSign(frame, kind, cfg));
      if (s.fired) {
        setProgress(1);
        fire.current();
        return;
      }
      const now = Date.now();
      if (Math.abs(s.progress - shown) > 0.05 && now - lastPush > 100) {
        shown = s.progress;
        lastPush = now;
        setProgress(s.progress);
      }
    });
    return () => {
      void handle.then((h) => h.remove());
      setProgress(0);
    };
  }, [active, kind, cfg]);
  return active ? progress : 0;
}

/** Tracking updates per second and whether the sign was seen, for the phone check's try-out. */
export async function tryOutSign(
  kind: StartSignKind,
  cfg: StartSignConfig,
  seconds: number,
  onProgress: (p: number) => void,
): Promise<{ seen: boolean; hz: number }> {
  const tracker = new StartSignTracker(cfg);
  const times: number[] = [];
  return new Promise((resolve) => {
    let finished = false;
    let h: { remove: () => Promise<void> } | null = null;
    const end = (seen: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void h?.remove();
      const span = times.length > 1 ? times[times.length - 1]! - times[0]! : 0;
      resolve({ seen, hz: span > 0 ? (times.length - 1) / span : 0 });
    };
    const timer = setTimeout(() => end(false), seconds * 1000);
    void capture.kit
      .addListener('analysisFrame', (e: AnalysisFrameEvent) => {
        const frame = decodeAnalysisFrame(e);
        const tS = Number(frame.tNs) / 1e9;
        times.push(tS);
        const s = tracker.update(tS, findSign(frame, kind, cfg));
        onProgress(s.progress);
        if (s.fired) end(true);
      })
      .then((x) => {
        h = x;
        if (finished) void x.remove();
      });
  });
}
