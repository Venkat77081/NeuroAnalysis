import { useEffect, useRef, useState } from 'react';
import type { QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import {
  decodeAnalysisFrame,
  type AnalysisFrameEvent,
  type SensorBatchEvent,
} from '@neurocapture/capture-kit';
import {
  AnalysisHealth,
  GuidanceEngine,
  SensorBuffer,
  evaluateFrame,
  gateRules,
  type CheckContext,
  type GuidanceState,
  type PromptKey,
  type Side,
} from '@neurocapture/quality-core';
import { capture } from '../lib/capture.ts';

export interface GuidanceOptions {
  test: TestConfig;
  quality: QualityConfig;
  side: Side | null;
  orientation: 'portrait' | 'landscape';
  sharpnessBaseline: number | null;
  sensors: boolean;
  /** Called with a prompt to speak (cooldown already applied). */
  onSpeak?: (key: PromptKey) => void;
  /** Called once each time the gate opens (lock AE/AF/AWB, haptic). */
  onGateOpen?: () => void;
}

const STALE_MS = 1000;

/**
 * Runs the positioning checks and rule engine on every analysis frame (DEV_PLAN §9.2–9.3).
 * All evaluation is in quality-core; this hook only wires native events to it and throttles
 * React updates. When frames stop arriving the windows expire and the state becomes "tracking".
 */
export function useGuidance(o: GuidanceOptions): GuidanceState | null {
  const [state, setState] = useState<GuidanceState | null>(null);
  const cb = useRef({ onSpeak: o.onSpeak, onGateOpen: o.onGateOpen });
  useEffect(() => {
    cb.current = { onSpeak: o.onSpeak, onGateOpen: o.onGateOpen };
  });
  const { test, quality, side, orientation, sharpnessBaseline, sensors: hasSensors } = o;

  useEffect(() => {
    const ctx: CheckContext = {
      test,
      quality,
      side,
      orientation,
      sharpnessBaseline,
      sensors: hasSensors,
    };
    const engine = new GuidanceEngine(gateRules(ctx), quality);
    const sensors = new SensorBuffer();
    const health = new AnalysisHealth();
    let lastT = 0n;
    let lastWall = 0;
    let lastPushed = '';
    const publish = (st: GuidanceState, nowNs: bigint) => {
      if (st.gateJustOpened) cb.current.onGateOpen?.();
      const spoken = engine.speech(st, nowNs);
      if (spoken) cb.current.onSpeak?.(spoken);
      const sig = `${st.gateOpen}|${st.prompt?.key}|${st.tracking}|${st.gateProgress.toFixed(1)}|${st.rules.map((r) => r.state).join()}`;
      if (sig !== lastPushed) {
        lastPushed = sig;
        setState(st);
      }
    };
    const handles: { remove: () => Promise<void> }[] = [];
    let cancelled = false;
    const keep = (h: { remove: () => Promise<void> }) =>
      cancelled ? void h.remove() : handles.push(h);
    void capture.kit
      .addListener('analysisFrame', (e: AnalysisFrameEvent) => {
        const frame = decodeAnalysisFrame(e);
        const latencyMs = e.emitNs ? Number(BigInt(e.emitNs) - frame.tNs) / 1e6 : 0;
        health.push(frame.tNs, latencyMs);
        engine.push(evaluateFrame(frame, sensors, ctx, health));
        lastT = frame.tNs;
        lastWall = performance.now();
        publish(engine.update(frame.tNs), frame.tNs);
      })
      .then(keep);
    void capture.kit
      .addListener('sensorBatch', (b: SensorBatchEvent) =>
        sensors.push(
          b.samples.map((s) => ({ type: s.type, tNs: BigInt(s.tsNs), x: s.x, y: s.y, z: s.z })),
        ),
      )
      .then(keep);
    // No frames for a while (camera stalled, tracker hung): let the windows expire → "tracking".
    const stale = setInterval(() => {
      const idle = performance.now() - lastWall;
      if (lastWall && idle > STALE_MS)
        publish(engine.update(lastT + BigInt(Math.round(idle * 1e6))), lastT);
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(stale);
      for (const h of handles) void h.remove();
      setState(null);
    };
  }, [test, quality, side, orientation, sharpnessBaseline, hasSensors]);

  return state;
}
