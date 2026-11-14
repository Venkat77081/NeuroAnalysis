/**
 * Cross-language readiness golden files (M8). The server's Python port
 * (backend/analysis/readiness.py) must give exactly what quality-core gives on the same
 * landmarks.bin and evidence; backend/tests/test_readiness.py checks the same files.
 * Regenerate after an intended change: UPDATE_GOLDEN=1 pnpm --filter @neurocapture/replay test
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LandmarksHeader } from '@neurocapture/contracts-ts';
import {
  encodeAnalysisFrame,
  encodeLandmarks,
  framesFromLandmarksFile,
  recordFromEvent,
} from '@neurocapture/capture-kit';
import {
  readinessHint,
  syntheticTake,
  type LandmarkFrame,
  type ReadinessEvidence,
  type TrackerName,
} from '@neurocapture/quality-core';
import { loadConfig } from '../src/replay.ts';

const repo = resolve(import.meta.dirname, '../../..');
const dir = join(repo, 'contracts/tests/readiness');
const config = loadConfig(join(repo, 'config'));
const update = process.env.UPDATE_GOLDEN === '1';

interface GoldenCase {
  name: string;
  testCode: string;
  landmarksFile: string;
  evidence: Omit<ReadinessEvidence, 'frames' | 'startNs'> & { startNs: string };
  expected: ReturnType<typeof readinessHint>;
}

function landmarksBytes(frames: LandmarkFrame[], code: string): Uint8Array {
  const test = config.tests.get(code)!;
  const header = {
    schemaVersion: '1.0.0',
    layout: 'NCLM-v1',
    takeId: `golden-${code}`,
    coordinateSystem: 'normalized_upright_analysis_frame',
    orientation: test.camera.orientation,
    image: frames[0]!.image,
    mirrored: false,
    imageMirrored: false,
    handednessLabels: 'mediapipe_raw',
    timestampSemantics: 'camera_frame_canonical_elapsed_realtime_ns',
    clockSource: 'SIMULATED',
    record: { endianness: 'little', dtype: 'float32' },
    trackers: test.trackers.map((name) => ({
      name,
      modelVersion: 'golden',
      pointsPerFrame: { hand: 21, pose: 33, face: 478 }[name],
      valuesPerPoint: name === 'face' ? 3 : 4,
    })),
  } as unknown as LandmarksHeader;
  return encodeLandmarks(
    header,
    frames.map((f) => recordFromEvent(encodeAnalysisFrame(f))),
  );
}

/** Small synthetic takes chosen to hit every status and reason. */
function cases(): {
  name: string;
  code: string;
  frames: LandmarkFrame[];
  ev: Partial<ReadinessEvidence>;
}[] {
  const take = (code: string, fps: number, n: number) =>
    syntheticTake(config.tests.get(code)!, 'normal', { fps }).frames.slice(0, n);
  const ft = take('FT', 10, 30).map((f, i) => (i % 3 === 0 ? { ...f, hands: [] } : f));
  const saw = take('SAW', 5, 10);
  const fa = take('FA', 5, 10).map((f, i) =>
    i % 2 && f.face
      ? {
          ...f,
          face: { ...f.face, pts: f.face.pts.map((p, k) => (k === 61 ? { ...p, x: 1.2 } : p)) },
        }
      : f,
  );
  return [
    { name: 'ft-partial-landmarks', code: 'FT', frames: ft, ev: {} },
    {
      name: 'ft-fps-duration-window',
      code: 'FT',
      frames: ft,
      ev: { effectiveFps: 41.24, durationS: 9.95, movementWindow: { tStartS: 0.15, tEndS: 1.45 } },
    },
    {
      name: 'saw-phases-missing',
      code: 'SAW',
      frames: saw,
      ev: { phases: ['stand_up', 'walk_out'] },
    },
    { name: 'fa-mouth-corner-off-image', code: 'FA', frames: fa, ev: {} },
  ];
}

describe('readiness golden files (M8, TypeScript side)', () => {
  it('quality-core reproduces every golden case', () => {
    if (update) mkdirSync(dir, { recursive: true });
    for (const c of cases()) {
      const test = config.tests.get(c.code)!;
      const file = `${c.name}.landmarks.bin`;
      if (update) writeFileSync(join(dir, file), landmarksBytes(c.frames, c.code));
      const bytes = new Uint8Array(readFileSync(join(dir, file)));
      const frames = framesFromLandmarksFile(bytes).frames;
      const startNs = frames[0]!.tNs;
      const evidence = {
        effectiveFps: 59.9,
        durationS: test.task.durationS,
        trackers: test.trackers as TrackerName[],
        movementWindow: null,
        phases: [],
        sensors: true,
        handsNeeded: test.framing.bothHandsRequired ? 2 : 1,
        poseMinVisibility: config.quality.checks.required_landmarks_visible.poseMinVisibility,
        handMinScore: config.quality.checks.required_landmarks_visible.handMinScore,
        ...c.ev,
      };
      const got = readinessHint(config.registry!, c.code, { ...evidence, frames, startNs });
      const path = join(dir, `${c.name}.json`);
      if (update) {
        const golden: GoldenCase = {
          name: c.name,
          testCode: c.code,
          landmarksFile: file,
          evidence: { ...evidence, startNs: startNs.toString() },
          expected: got,
        };
        writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`);
      }
      expect(existsSync(path), path).toBe(true);
      const golden = JSON.parse(readFileSync(path, 'utf8')) as GoldenCase;
      expect(got, c.name).toEqual(golden.expected);
    }
  });

  it('the golden set covers every status', () => {
    const statuses = new Set(
      cases().flatMap((c) => {
        const g = JSON.parse(readFileSync(join(dir, `${c.name}.json`), 'utf8')) as GoldenCase;
        return Object.values(g.expected.items).map((i) => i.status);
      }),
    );
    expect(statuses).toEqual(new Set(['PARTIAL', 'NOT_COMPUTABLE']));
  });
});
