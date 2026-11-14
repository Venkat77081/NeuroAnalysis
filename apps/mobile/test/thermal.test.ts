import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.ts';
import { thermalPolicy } from '../src/lib/thermal.ts';

describe('thermal policy (M9)', () => {
  const cfg = loadConfig().session.thermal;
  it('nothing changes while the phone is cool', () => {
    for (const s of ['none', 'light', 'unsupported'] as const)
      expect(thermalPolicy(s, cfg)).toBeNull();
    expect(thermalPolicy('severe', undefined)).toBeNull();
  });
  it('slows tracking first, then hides overlays, then asks to cool down; never the recording', () => {
    expect(thermalPolicy('moderate', cfg)).toMatchObject({
      level: 'moderate',
      analysisFps: 10,
      overlays: true,
      blockNewTakes: false,
    });
    expect(thermalPolicy('severe', cfg)).toMatchObject({
      analysisFps: 5,
      overlays: false,
      warn: true,
      blockNewTakes: false,
    });
    for (const s of ['critical', 'emergency', 'shutdown'] as const)
      expect(thermalPolicy(s, cfg)).toMatchObject({ level: 'critical', blockNewTakes: true });
  });
});
