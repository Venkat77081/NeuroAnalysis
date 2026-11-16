import { describe, expect, it } from 'vitest';
import { faceAngles, faceLumaRatio, frameStats } from '../src/frame-math.ts';

/** Column-major 4×4 of Rz(roll)·Ry(yaw)·Rx(pitch). */
function matrix(yaw: number, pitch: number, roll: number): number[] {
  const [y, p, r] = [yaw, pitch, roll].map((d) => (d * Math.PI) / 180) as [number, number, number];
  const rx = [
    [1, 0, 0],
    [0, Math.cos(p), -Math.sin(p)],
    [0, Math.sin(p), Math.cos(p)],
  ];
  const ry = [
    [Math.cos(y), 0, Math.sin(y)],
    [0, 1, 0],
    [-Math.sin(y), 0, Math.cos(y)],
  ];
  const rz = [
    [Math.cos(r), -Math.sin(r), 0],
    [Math.sin(r), Math.cos(r), 0],
    [0, 0, 1],
  ];
  const mul = (a: number[][], b: number[][]) =>
    a.map((row) => b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)));
  const m = mul(mul(rz, ry), rx);
  const out = new Array(16).fill(0);
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) out[col * 4 + row] = m[row]![col]!;
  out[15] = 1;
  return out;
}

const image = (w: number, h: number, f: (x: number, y: number) => number) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      d.set([v, v, v, 255], (y * w + x) * 4);
    }
  return d;
};

describe('frame math (webcam mode)', () => {
  it('recovers face angles', () => {
    const a = faceAngles(matrix(20, -10, 5));
    expect(a.yawDeg).toBeCloseTo(20, 3);
    expect(a.pitchDeg).toBeCloseTo(-10, 3);
    expect(a.rollDeg).toBeCloseTo(5, 3);
  });

  it('measures brightness, clipping and sharpness', () => {
    expect(
      frameStats(
        image(32, 32, () => 128),
        32,
        32,
      ),
    ).toEqual({ lumaMean: 128, clippedFrac: 0, sharpness: 0 });
    const c = frameStats(
      image(32, 32, (x, y) => ((x + y) % 2 ? 255 : 0)),
      32,
      32,
    );
    expect(c.sharpness).toBeGreaterThan(1000);
    expect(c.clippedFrac).toBe(1);
    expect(frameStats(new Uint8ClampedArray(0), 0, 0)).toEqual({
      lumaMean: 0,
      clippedFrac: 0,
      sharpness: 0,
    });
  });

  it('computes the face light balance', () => {
    const d = image(100, 100, (x) => (x < 50 ? 200 : 100));
    expect(faceLumaRatio(d, 100, 100, [0.2, 0.2, 0, 0.8, 0.8, 0])).toBeCloseTo(2, 1);
    expect(faceLumaRatio(d, 100, 100, [0.5, 0.5, 0])).toBeNull();
    expect(
      faceLumaRatio(
        image(10, 10, () => 0),
        10,
        10,
        [0, 0, 0, 1, 1, 0],
      ),
    ).toBeNull();
  });
});
