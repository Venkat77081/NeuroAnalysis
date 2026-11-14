import {
  validate,
  checkTestConfig,
  checkSessionConfig,
  checkQualityConfig,
} from '@neurocapture/contracts-ts';
import type {
  DeviceTiersConfig,
  QualityConfig,
  SessionConfig,
  TestConfig,
} from '@neurocapture/contracts-ts';
import quality from '../../../../config/quality.json' with { type: 'json' };
import deviceTiers from '../../../../config/device-tiers.json' with { type: 'json' };
import session from '../../../../config/session.json' with { type: 'json' };
import FT from '../../../../config/tests/FT.json' with { type: 'json' };
import FTF from '../../../../config/tests/FTF.json' with { type: 'json' };
import FR from '../../../../config/tests/FR.json' with { type: 'json' };
import SAW from '../../../../config/tests/SAW.json' with { type: 'json' };
import FA from '../../../../config/tests/FA.json' with { type: 'json' };

export interface LoadedConfig {
  session: SessionConfig;
  tiers: DeviceTiersConfig;
  quality: QualityConfig;
  tests: Map<string, TestConfig>;
  errors: string[];
}

/** Load and validate the bundled configs. The app refuses clinical capture if errors is non-empty. */
export function loadConfig(
  raw: { session: unknown; tests: Record<string, unknown>; tiers?: unknown; quality?: unknown } = {
    session,
    tests: { FT, FTF, FR, SAW, FA },
    tiers: deviceTiers,
    quality,
  },
): LoadedConfig {
  const errors: string[] = [];
  const tests = new Map<string, TestConfig>();
  for (const [code, cfg] of Object.entries(raw.tests)) {
    const res = validate('test-config', cfg);
    errors.push(...res.issues.map((i) => `tests/${code}.json ${i.path || '/'} ${i.message}`));
    if (res.valid) {
      const tc = cfg as TestConfig;
      errors.push(
        ...checkTestConfig(tc, code).map((i) => `tests/${code}.json ${i.path} ${i.message}`),
      );
      tests.set(code, tc);
    }
  }
  const sres = validate('session-config', raw.session);
  errors.push(...sres.issues.map((i) => `session.json ${i.path || '/'} ${i.message}`));
  if (sres.valid) {
    errors.push(
      ...checkSessionConfig(raw.session as SessionConfig, tests).map(
        (i) => `session.json ${i.path} ${i.message}`,
      ),
    );
  }
  const tiers = raw.tiers ?? deviceTiers;
  errors.push(
    ...validate('device-tiers', tiers).issues.map(
      (i) => `device-tiers.json ${i.path || '/'} ${i.message}`,
    ),
  );
  const q = raw.quality ?? quality;
  const qres = validate('quality-config', q);
  errors.push(...qres.issues.map((i) => `quality.json ${i.path || '/'} ${i.message}`));
  if (qres.valid) {
    errors.push(
      ...checkQualityConfig(q as QualityConfig).map((i) => `quality.json ${i.path} ${i.message}`),
    );
  }
  return {
    session: raw.session as SessionConfig,
    quality: q as QualityConfig,
    tests,
    tiers: tiers as DeviceTiersConfig,
    errors,
  };
}
