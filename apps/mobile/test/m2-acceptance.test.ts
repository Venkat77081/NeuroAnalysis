import { describe, expect, it } from 'vitest';
import type { RecordingResult } from '@neurocapture/capture-kit';
import { allPass, checkTake, summarize } from '../src/lib/m2-acceptance.ts';

const good: RecordingResult = {
  takeId: 't',
  createdAt: '2026-11-13T10:00:00Z',
  durationS: 15.02,
  requestedDurationS: 15,
  durationErrorMs: 20,
  stoppedEarly: false,
  frameCount: 899,
  effectiveFps: 59.9,
  droppedFrames: 1,
  droppedFrac: 0.001,
  actualFps: 60,
  framesLogged: 905,
  framesInVideoSpan: 900,
  mp4: {
    sampleCount: 899,
    firstRecordIndex: 3,
    maxAbsDiffMs: 0.4,
    p95AbsDiffMs: 0.2,
    unmatchedSamples: 0,
    anchor: 'pattern',
  },
  sensorSamples: 3000,
  sensorClockOffsetMs: 0.3,
  encrypted: true,
  encryptedNotPlayable: true,
  files: { video: '', frames: '', landmarks: '', sensors: '' },
};

describe('M2 acceptance', () => {
  it('passes a good take', () => {
    expect(allPass(checkTake(good, 29.5))).toBe(true);
  });

  it.each([
    ['duration', { durationErrorMs: 60 }],
    ['duration', { stoppedEarly: true }],
    ['fps', { effectiveFps: 29 }],
    ['frameCount', { framesInVideoSpan: 902 }],
    ['frameCount', { mp4: null }],
    ['timestamps', { mp4: { ...good.mp4!, maxAbsDiffMs: 2.5 } }],
    ['timestamps', { mp4: { ...good.mp4!, unmatchedSamples: 2 } }],
    ['encrypted', { encryptedNotPlayable: null }],
    ['encrypted', { encrypted: false }],
  ] as const)('fails %s', (key, patch) => {
    const c = checkTake({ ...good, ...patch } as RecordingResult, 29.5);
    expect(c[key]).toBe(false);
    expect(allPass(c)).toBe(false);
  });

  it('tolerates one unmatched sample (a frame missing from the log)', () => {
    expect(
      checkTake({ ...good, mp4: { ...good.mp4!, unmatchedSamples: 1 } }, 29.5).timestamps,
    ).toBe(true);
  });

  it('summarizes a batch', () => {
    const s = summarize(
      [
        good,
        {
          ...good,
          durationErrorMs: -35,
          effectiveFps: 30,
          mp4: { ...good.mp4!, anchor: 'earliest_candidate' },
        },
      ],
      29.5,
    );
    expect(s).toEqual({
      takes: 2,
      passed: 2,
      maxAbsDurationErrorMs: 35,
      minEffectiveFps: 30,
      maxTimestampDiffMs: 0.4,
      maxDroppedFrac: 0.001,
      ambiguousAnchors: 1,
    });
    expect(summarize([], 29.5).takes).toBe(0);
  });
});
