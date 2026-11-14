import { describe, expect, it } from 'vitest';
import { validate } from '@neurocapture/contracts-ts';
import { MockCaptureKit, sampleFixtures, type RecordingResult } from '@neurocapture/capture-kit';
import { buildMeta } from '../src/lib/evidence.ts';
import { loadConfig } from '../src/lib/config.ts';
import type { SessionContext } from '../src/session/machine.ts';

describe('buildMeta', () => {
  it('produces schema-valid meta.json without patient identifiers', async () => {
    const config = loadConfig();
    const caps = await new MockCaptureKit({
      fixture: sampleFixtures['ft-r-sample'],
    }).getCapabilities();
    const ctx = {
      sessionId: 's-1',
      operatorId: 'OP-07',
      plan: [{ code: 'FT', side: 'R' }],
      index: 0,
      medState: 'ON',
      patient: { localId: 'p', ref: 'SECRET-REF', yearOfBirth: 1950, sex: 'F' },
    } as unknown as SessionContext;
    const meta = buildMeta({
      ctx,
      cfg: config.tests.get('FT')!,
      sessionConfigVersion: config.session.configVersion,
      result: { takeId: 'tk-1', actualFps: 60 } as RecordingResult,
      takeNo: 2,
      caps,
      implementation: 'mock',
      tier: null,
      createdAt: '2026-11-13T10:00:00.000Z',
    });
    expect(validate('meta', meta).issues).toEqual([]);
    expect(meta).toMatchObject({ testCode: 'FT', side: 'R', take: 2, tier: 'W', medState: 'ON' });
    expect(JSON.stringify(meta)).not.toContain('SECRET-REF');
    const noCaps = buildMeta({
      ctx,
      cfg: config.tests.get('FT')!,
      sessionConfigVersion: 'SESSION@1.1.0',
      result: { takeId: 'tk-2', actualFps: 30 } as RecordingResult,
      takeNo: 1,
      caps: null,
      implementation: 'native',
      tier: null,
      createdAt: '2026-11-13T10:00:00.000Z',
    });
    expect(validate('meta', noCaps).issues).toEqual([]);
    expect(noCaps.tier).toBeNull();
  });

  it('records the orientation the operator chose', () => {
    const config = loadConfig();
    const ctx = {
      sessionId: 's-1',
      operatorId: 'OP-07',
      plan: [{ code: 'FT', side: null }],
      index: 0,
      medState: 'ON',
    } as unknown as SessionContext;
    const base = {
      ctx,
      cfg: config.tests.get('FT')!,
      sessionConfigVersion: config.session.configVersion,
      result: { takeId: 'tk-3', actualFps: 60 } as RecordingResult,
      takeNo: 1,
      caps: null,
      implementation: 'mock' as const,
      tier: null,
      createdAt: '2026-11-14T10:00:00.000Z',
    };
    expect(buildMeta(base).camera.orientation).toBe('landscape');
    const meta = buildMeta({ ...base, orientation: 'portrait' });
    expect(meta.camera.orientation).toBe('portrait');
    expect(validate('meta', meta).issues).toEqual([]);
  });
});
