/**
 * M8 parity: takes recorded by the mock plugin and evaluated exactly as the app does
 * (evaluateOnDevice + buildQuality) give the same verdict, reasons and readiness when replayed
 * from their files. 50 takes: 5 tests × 5 performances × {full take, stopped early}.
 * The same check runs on real phone takes with `pnpm replay <dir> --check` (docs/qa/m8).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MockCaptureKit,
  base64ToBytes,
  sampleFixtures,
  scaledScheduler,
  type RecordingResult,
  type RecordingStateEvent,
} from '@neurocapture/capture-kit';
import type { TakeVariant } from '@neurocapture/quality-core';
import { evaluateOnDevice } from '../../../apps/mobile/src/lib/take-analysis.ts';
import { buildQuality } from '../../../apps/mobile/src/lib/evidence.ts';
import type { SessionContext } from '../../../apps/mobile/src/session/machine.ts';
import { findTakeDirs, loadConfig, replayTakeDir } from '../src/replay.ts';

const configDir = resolve(import.meta.dirname, '../../../config');
const config = loadConfig(configDir);
const CODES = ['FT', 'FTF', 'FR', 'SAW', 'FA'] as const;
const VARIANTS: TakeVariant[] = ['normal', 'slow', 'fast', 'interrupted', 'wrong'];
const SPEED = 40;

/** Record one take with the mock plugin and save it the way the phone does. */
async function recordTake(
  root: string,
  code: (typeof CODES)[number],
  variant: TakeVariant,
  stopEarly: boolean,
): Promise<string> {
  const test = config.tests.get(code)!;
  const scheduler = scaledScheduler(SPEED);
  const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'], scheduler });
  const orientation = test.camera.orientation as 'portrait' | 'landscape';
  await kit.openCamera({
    facing: 'back',
    resolution: '1080p',
    targetFps: 60,
    orientation,
    trackers: test.trackers,
    analysisFps: test.analysis.fps,
  });
  kit.setScenario({ test, name: 'good', side: null, take: variant });
  const takeId = `${code}-${variant}-${stopEarly ? 'early' : 'full'}`;
  const done = new Promise<RecordingResult>((ok) => {
    void kit.addListener('recordingState', (e: RecordingStateEvent) => {
      if (e.takeId === takeId && e.state === 'completed' && e.result) ok(e.result);
    });
  });
  await kit.startRecording({ takeId, durationS: test.task.durationS });
  // Stop early on the mock's own clock, so the stop lands at 60 % of the take however busy the host is.
  if (stopEarly)
    scheduler.setTimeout(
      () => void kit.stopRecording().catch(() => undefined),
      test.task.durationS * 600,
    );
  const result = await done;
  await kit.closeCamera();

  const take = await evaluateOnDevice({
    kit,
    collector: null,
    result,
    test,
    quality: config.quality,
    registry: config.registry,
    side: null,
    orientation,
    hasSensors: true,
    minEffectiveFps: test.camera.minEffectiveFps ?? 59,
    sharpnessBaseline: null,
  });
  const ctx = { plan: [{ code, side: null }], index: 0 } as unknown as SessionContext;
  const quality = buildQuality({
    ctx,
    cfg: test,
    result,
    takeNo: 1,
    implementation: 'mock',
    tier: null,
    take,
    sharpnessBaseline: null,
  });
  const dir = join(root, takeId);
  mkdirSync(dir);
  writeFileSync(join(dir, 'quality.json'), JSON.stringify(quality));
  writeFileSync(join(dir, 'capture.json'), JSON.stringify(result));
  const lm = (await kit.readLandmarks({ takeId })).data;
  if (lm) writeFileSync(join(dir, 'landmarks.bin'), base64ToBytes(lm));
  const se = (await kit.readSensors({ takeId })).data;
  if (se) writeFileSync(join(dir, 'sensors.bin'), base64ToBytes(se));
  return dir;
}

describe('replay parity (M8)', () => {
  it('50 takes: replayed verdict, reasons and readiness equal the phone’s', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nc-parity-'));
    // One take at a time, like a phone.
    for (const code of CODES)
      for (const variant of VARIANTS)
        for (const early of [false, true]) await recordTake(root, code, variant, early);
    const dirs = findTakeDirs(root);
    expect(dirs).toHaveLength(50);
    const results = dirs.map((d) => replayTakeDir(d, config));
    const bad = results.filter((r) => r.parity !== 'match');
    expect(bad.map((r) => `${r.dir}: ${r.parity} ${r.differences.join('; ')}`)).toEqual([]);
    // The library covers both outcomes, not only passes.
    const verdicts = new Set(results.map((r) => r.replayVerdict));
    expect(verdicts).toEqual(new Set(['PASS', 'RETAKE']));
    // Stopping early is always a retake (detector accuracy is tested in quality-core).
    for (const r of results)
      if (r.dir.endsWith('-early')) expect(r.replayVerdict, r.dir).toBe('RETAKE');
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('detects changed evidence and other versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nc-parity-'));
    const dir = await recordTake(root, 'FT', 'normal', false);
    writeFileSync(join(dir, 'sensors.bin'), new Uint8Array([1, 2, 3]));
    expect(replayTakeDir(dir, config).parity).toBe('input_mismatch');
    const other = { ...config, registry: { ...config.registry!, registryVersion: 'REG@9.9.9' } };
    const r = replayTakeDir(dir, other);
    expect(r.parity).toBe('version_mismatch');
    expect(r.differences.join('; ')).toContain('registryVersion');
    rmSync(root, { recursive: true, force: true });
  }, 60_000);
});
