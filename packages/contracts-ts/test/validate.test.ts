import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  validate,
  formatIssues,
  checkTestConfig,
  checkSessionConfig,
  schemaNames,
  isSchemaName,
} from '../src/index.ts';
import type { TestConfig, SessionConfig } from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
const testCodes = ['FT', 'FTF', 'FR', 'SAW', 'FA'];

describe('config files', () => {
  it.each(testCodes)('config/tests/%s.json is valid and semantically consistent', (code) => {
    const cfg = read<TestConfig>(`config/tests/${code}.json`);
    expect(validate('test-config', cfg).issues).toEqual([]);
    expect(checkTestConfig(cfg, code)).toEqual([]);
  });

  it('uses fixed durations: 15 s, and 45 s for SAW (decisions 002, 013)', () => {
    for (const code of testCodes) {
      const cfg = read<TestConfig>(`config/tests/${code}.json`);
      expect(cfg.task.durationS).toBe(code === 'SAW' ? 45 : 15);
    }
  });

  it('uses the interim fps policy: RETAKE only below 29.5 fps, drops not enforced (decision 007)', () => {
    for (const code of testCodes) {
      const cfg = read<TestConfig>(`config/tests/${code}.json`);
      expect(cfg.camera.minEffectiveFps).toBe(29.5);
      expect(cfg.verdict.maxDroppedFrac).toBeNull();
      expect(cfg.camera.fallbackFps).toBe(cfg.camera.targetFps === 60 ? 30 : undefined);
    }
  });

  it('session config is valid and references existing tests', () => {
    const tests = new Map(testCodes.map((c) => [c, read<TestConfig>(`config/tests/${c}.json`)]));
    const session = read<SessionConfig>('config/session.json');
    expect(validate('session-config', session).issues).toEqual([]);
    expect(checkSessionConfig(session, tests)).toEqual([]);
  });
});

describe('compatibility samples', () => {
  for (const schema of schemaNames) {
    const dir = join(root, 'contracts/tests/valid', schema);
    for (const f of readdirSync(dir)) {
      it(`valid/${schema}/${f} validates`, () => {
        expect(validate(schema, read(`contracts/tests/valid/${schema}/${f}`)).issues).toEqual([]);
      });
    }
  }

  const expected = read<Record<string, string>>('contracts/tests/invalid/expected.json');
  for (const [key, field] of Object.entries(expected).filter(([k]) => !k.startsWith('_'))) {
    it(`invalid/${key} fails naming ${field}`, () => {
      const schema = key.split('/')[0]!;
      expect(isSchemaName(schema)).toBe(true);
      if (!isSchemaName(schema)) return;
      const res = validate(schema, read(`contracts/tests/invalid/${key}`));
      expect(res.valid).toBe(false);
      expect(res.issues.map((i) => i.path)).toContain(field);
      expect(formatIssues(key, res.issues)).toContain(`field "${field}"`);
    });
  }
});

describe('semantic checks', () => {
  const ft = read<TestConfig>('config/tests/FT.json');

  it('flags a file name that does not match the code', () => {
    expect(checkTestConfig(ft, 'FR').map((i) => i.path)).toContain('/code');
  });

  it('flags configVersion prefix, inverted ranges, fps and foreign biomarker IDs', () => {
    const bad: TestConfig = structuredClone(ft);
    bad.configVersion = 'FR@1.0.0';
    bad.setup.distanceM = [1.0, 0.6];
    bad.framing.subjectSize = { ...bad.framing.subjectSize, min: 0.5, max: 0.4 };
    bad.camera.minEffectiveFps = 61;
    bad.biomarkers = ['FT1', 'FR2'];
    const paths = checkTestConfig(bad).map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/configVersion',
        '/setup/distanceM',
        '/framing/subjectSize',
        '/camera/minEffectiveFps',
        '/biomarkers',
      ]),
    );
  });

  it('flags landmarks for a tracker that is not enabled, and handedness on an unsided test', () => {
    const bad: TestConfig = structuredClone(ft);
    bad.trackers = ['hand'];
    bad.framing.requiredLandmarks = { hand: [0], pose: [11] };
    bad.framing.handednessMustMatchSide = true;
    bad.sides = [];
    const paths = checkTestConfig(bad).map((i) => i.path);
    expect(paths).toContain('/framing/requiredLandmarks/pose');
    expect(paths).toContain('/framing/handednessMustMatchSide');
  });

  it('flags allowed orientations that leave out the default', () => {
    const bad: TestConfig = structuredClone(ft);
    bad.camera.orientation = 'landscape';
    bad.camera.allowedOrientations = ['portrait'];
    expect(checkTestConfig(bad).map((i) => i.path)).toContain('/camera/allowedOrientations');
    bad.camera.allowedOrientations = ['portrait', 'landscape'];
    expect(checkTestConfig(bad).map((i) => i.path)).not.toContain('/camera/allowedOrientations');
  });

  it('flags unknown tests and wrong sides in the session order', () => {
    const sidedFt: TestConfig = { ...structuredClone(ft), sides: ['R', 'L'] };
    const tests = new Map([
      ['FT', sidedFt],
      ['SAW', read<TestConfig>('config/tests/SAW.json')],
    ]);
    const session = read<SessionConfig>('config/session.json');
    session.order = [
      ['FT', null],
      ['SAW', 'R'],
      ['FA', null],
    ];
    expect(checkSessionConfig(session, tests).map((i) => i.path)).toEqual([
      '/order/0/1',
      '/order/1/1',
      '/order/2/0',
    ]);
  });
});

describe('validate()', () => {
  it('reports unreadable shapes at the document root', () => {
    const res = validate('meta', 42);
    expect(res.valid).toBe(false);
    expect(res.issues[0]?.path).toBe('');
  });
});
