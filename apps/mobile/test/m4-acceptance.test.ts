import { describe, expect, it } from 'vitest';
import {
  checkTracking,
  clockOffsetNs,
  M4_LIMITS,
  percentile,
  summarizeTracking,
  type TrackingSample,
} from '../src/lib/m4-acceptance.ts';
import {
  containTransform,
  coverTransform,
  nearestIndex,
  toScreen,
} from '../src/overlays/landmark-geometry.ts';

const sample = (i: number, over: Partial<TrackingSample> = {}): TrackingSample => ({
  tsNs: BigInt(i) * 40_000_000n, // 25 fps
  latencyMs: 30 + (i % 10),
  bytes: 4000,
  procMs: 12,
  error: false,
  ...over,
});

describe('M4 acceptance', () => {
  it('nearest-rank percentile', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBeNaN();
  });

  it('clock offset uses the shortest round trip midpoint', () => {
    const r = clockOffsetNs([
      { beforeMs: 100, afterMs: 120, nativeNs: 5_000_000_000n },
      { beforeMs: 200, afterMs: 202, nativeNs: 5_101_000_000n },
    ]);
    expect(r.rttMs).toBe(2);
    expect(r.offsetNs).toBe(5_101_000_000n - 201_000_000n);
    expect(() => clockOffsetNs([])).toThrow();
  });

  it('summarizes a passing run', () => {
    const s = summarizeTracking(Array.from({ length: 101 }, (_, i) => sample(i)));
    expect(s.events).toBe(101);
    expect(s.analysisFps).toBeCloseTo(25, 5);
    expect(s.latencyP95Ms).toBe(39);
    expect(s.maxEventBytes).toBe(4000);
    expect(checkTracking(s)).toEqual({ fps: true, latency: true, size: true });
  });

  it('flags slow, late and oversized events', () => {
    const s = summarizeTracking([
      sample(0, { tsNs: 0n, latencyMs: 200, bytes: M4_LIMITS.eventBytes + 1, error: true }),
      sample(1, { tsNs: 100_000_000n, latencyMs: 200 }),
    ]);
    expect(s.analysisFps).toBeCloseTo(10);
    expect(s.errorFrames).toBe(1);
    expect(checkTracking(s)).toEqual({ fps: false, latency: false, size: false });
    expect(checkTracking(summarizeTracking([])).size).toBe(false);
  });
});

describe('toScreen', () => {
  const t = {
    scaleX: 400,
    scaleY: 800,
    offsetX: -10,
    offsetY: 20,
    rotationDeg: 0 as const,
    mirrored: false,
  };
  it('applies scale and offset', () => {
    expect(toScreen(0.5, 0.25, t)).toEqual({ x: 190, y: 220 });
  });
  it('mirrors x for the front camera', () => {
    expect(toScreen(0.25, 0.5, { ...t, mirrored: true })).toEqual({ x: 290, y: 420 });
  });
  it('handles rotated streams', () => {
    const u = { ...t, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    expect(toScreen(0.1, 0.2, { ...u, rotationDeg: 90 })).toEqual({ x: 0.8, y: 0.1 });
    expect(toScreen(0.1, 0.2, { ...u, rotationDeg: 180 })).toEqual({ x: 0.9, y: 0.8 });
    expect(toScreen(0.1, 0.2, { ...u, rotationDeg: 270 })).toEqual({ x: 0.2, y: 0.9 });
  });
});

describe('coverTransform', () => {
  it('fills a landscape screen with a 16:9 image (crops top and bottom)', () => {
    const t = coverTransform(854, 480, 915, 412, false);
    expect(t.scaleX).toBeCloseTo(915);
    expect(t.scaleY).toBeCloseTo(514.3, 1);
    expect(t.offsetX).toBeCloseTo(0);
    expect(t.offsetY).toBeCloseTo(-51.1, 1);
    expect(toScreen(0.5, 0.5, t)).toEqual({ x: 457.5, y: 206 });
  });
  it('fills a portrait screen (crops the sides) and keeps mirroring', () => {
    const t = coverTransform(480, 854, 412, 915, true);
    expect(t.scaleY).toBeCloseTo(915);
    expect(t.offsetX).toBeLessThan(0);
    expect(t.mirrored).toBe(true);
  });
});

describe('replay mapping', () => {
  it('contain-fits a video in its box (letterbox)', () => {
    const t = containTransform(1920, 1080, 400, 800);
    expect(t.scaleX).toBeCloseTo(400);
    expect(t.scaleY).toBeCloseTo(225);
    expect(t.offsetY).toBeCloseTo(287.5);
  });
  it('finds the record nearest to a video time', () => {
    const times = [0n, 33n, 66n, 100n];
    expect(nearestIndex([], 5n)).toBe(-1);
    expect(nearestIndex(times, -5n)).toBe(0);
    expect(nearestIndex(times, 40n)).toBe(1);
    expect(nearestIndex(times, 60n)).toBe(2);
    expect(nearestIndex(times, 500n)).toBe(3);
  });
});
