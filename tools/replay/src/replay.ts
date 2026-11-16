/**
 * tools/replay (DEV_PLAN M8): recompute a take's verdict and readiness from its own evidence with
 * the same quality-core build the phone ran, and compare with what the phone wrote.
 *
 * A take directory holds the take's plaintext files: quality.json (required), landmarks.bin and
 * sensors.bin (when recorded), capture.json (the RecordingResult; optional, quality.json values are
 * used otherwise). Encrypted uploads are first decrypted on the server
 * (backend/analysis/export_take.py, dev keys only).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  BiomarkerRegistry,
  QualityConfig,
  QualityReport,
  TestConfig,
} from '@neurocapture/contracts-ts';
import { framesFromLandmarksFile, readingsFromSensorsFile } from '@neurocapture/capture-kit';
import {
  QUALITY_CORE_VERSION,
  evaluateRecordedTake,
  evaluationFields,
  type EvaluationFields,
  type TakeFacts,
} from '@neurocapture/quality-core';

export interface ReplayConfig {
  quality: QualityConfig;
  registry: BiomarkerRegistry | null;
  tests: Map<string, TestConfig>;
}

export type Parity =
  | 'match'
  | 'mismatch'
  /** Different config / quality-core / registry version: parity is not defined. */
  | 'version_mismatch'
  /** The files differ from the ones the phone evaluated (SHA-256). */
  | 'input_mismatch'
  /** quality.json from before M8 (no replayInputs). */
  | 'no_inputs';

export interface ReplayResult {
  dir: string;
  testCode: string;
  deviceVerdict: string;
  replayVerdict: string;
  parity: Parity;
  differences: string[];
  /** quality.json with the recomputed evaluation fields. */
  quality: QualityReport;
}

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Configs from a repo-style config directory (config/quality.json, config/tests/*.json, …). */
export function loadConfig(dir: string): ReplayConfig {
  const tests = new Map<string, TestConfig>();
  for (const f of readdirSync(join(dir, 'tests')).filter((n) => n.endsWith('.json'))) {
    const t = read<TestConfig>(join(dir, 'tests', f));
    tests.set(t.code, t);
  }
  const reg = join(dir, 'biomarker-registry.json');
  return {
    quality: read<QualityConfig>(join(dir, 'quality.json')),
    registry: existsSync(reg) ? read<BiomarkerRegistry>(reg) : null,
    tests,
  };
}

/** Take directories under `root` (any folder that holds a quality.json), sorted. */
export function findTakeDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (existsSync(join(d, 'quality.json'))) out.push(d);
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(resolve(root));
  return out;
}

const COMPARED: (keyof EvaluationFields)[] = [
  'captureVerdict',
  'captureReasons',
  'biomarkerReadinessHint',
  'eventsDetected',
  'phasesDetected',
  'landmarkVisibleFrac',
  'movementWindow',
  'events',
  'unknownWindows',
];

export function replayTakeDir(dir: string, config: ReplayConfig): ReplayResult {
  const device = read<QualityReport>(join(dir, 'quality.json'));
  const test = config.tests.get(device.testCode);
  if (!test) throw new Error(`${dir}: no config for test ${device.testCode}`);
  const inputs = device.replayInputs;
  const differences: string[] = [];

  const file = (name: string) =>
    existsSync(join(dir, name)) ? new Uint8Array(readFileSync(join(dir, name))) : null;
  const lm = file('landmarks.bin');
  const se = file('sensors.bin');
  const capture = existsSync(join(dir, 'capture.json'))
    ? read<TakeFacts & { mp4?: { firstSampleNs?: string } | null }>(join(dir, 'capture.json'))
    : null;
  const facts: TakeFacts = capture ?? {
    durationS: device.durationS,
    requestedDurationS: device.durationTargetS,
    stoppedEarly: device.stoppedEarly,
    effectiveFps: device.fpsEffective,
    droppedFrac: device.droppedFrac,
  };
  const firstSampleNs = inputs?.firstSampleNs ?? capture?.mp4?.firstSampleNs ?? null;

  const decode = <T>(name: string, bytes: Uint8Array | null, f: (b: Uint8Array) => T[]): T[] => {
    if (!bytes) return [];
    try {
      return f(bytes);
    } catch (e) {
      differences.push(`${name} unreadable: ${(e as Error).message}`);
      return [];
    }
  };
  const ev = evaluateRecordedTake({
    frames: decode('landmarks.bin', lm, (b) => framesFromLandmarksFile(b).frames),
    sensors: decode('sensors.bin', se, readingsFromSensorsFile),
    facts,
    firstSampleNs: firstSampleNs ? BigInt(firstSampleNs) : null,
    test,
    quality: config.quality,
    registry: config.registry,
    side: device.side,
    orientation: inputs?.orientation ?? (test.camera.orientation as 'portrait' | 'landscape'),
    sharpnessBaseline: device.sharpnessBaseline,
    hasSensors: inputs?.hasSensors ?? se !== null,
    minEffectiveFps: inputs?.minEffectiveFps ?? test.camera.minEffectiveFps ?? 59,
  });
  const fields = evaluationFields(ev);
  const quality = {
    ...device,
    ...fields,
    qualityCoreVersion: QUALITY_CORE_VERSION,
  } as QualityReport;

  let parity: Parity = 'match';
  if (differences.length) parity = 'input_mismatch';
  const versions: [string, string, string][] = [
    ['configVersion', device.configVersion, test.configVersion],
    ['qualityCoreVersion', device.qualityCoreVersion, QUALITY_CORE_VERSION],
    [
      'registryVersion',
      device.biomarkerReadinessHint.registryVersion,
      config.registry?.registryVersion ?? 'REG@0.0.0',
    ],
  ];
  for (const [name, was, now] of versions)
    if (was !== now) {
      differences.push(`${name}: device ${was}, replay ${now}`);
      parity = 'version_mismatch';
    }
  if (!inputs) {
    parity = 'no_inputs';
    differences.push('quality.json has no replayInputs (recorded before M8)');
  } else if (parity === 'match') {
    const digest = (b: Uint8Array | null) => (b ? sha256(b) : null);
    if (inputs.source === 'live')
      differences.push('the phone evaluated live frames (files were unreadable)');
    if (digest(lm) !== inputs.landmarksSha256) differences.push('landmarks.bin differs');
    if (digest(se) !== inputs.sensorsSha256) differences.push('sensors.bin differs');
    if (differences.length) parity = 'input_mismatch';
  }
  if (parity === 'match')
    for (const k of COMPARED) {
      const a = JSON.stringify(device[k] ?? null);
      const b = JSON.stringify(fields[k] ?? null);
      if (a !== b) {
        parity = 'mismatch';
        differences.push(`${k}: device ${a.slice(0, 200)} ≠ replay ${b.slice(0, 200)}`);
      }
    }
  return {
    dir,
    testCode: device.testCode,
    deviceVerdict: device.captureVerdict,
    replayVerdict: fields.captureVerdict,
    parity,
    differences,
    quality,
  };
}
