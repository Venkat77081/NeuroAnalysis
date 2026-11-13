import { validate, checkTestConfig, checkSessionConfig } from '@neurocapture/contracts-ts';
import type { SessionConfig, TestConfig } from '@neurocapture/contracts-ts';
import session from '../../../../config/session.json' with { type: 'json' };
import FT from '../../../../config/tests/FT.json' with { type: 'json' };
import FTF from '../../../../config/tests/FTF.json' with { type: 'json' };
import FR from '../../../../config/tests/FR.json' with { type: 'json' };
import SAW from '../../../../config/tests/SAW.json' with { type: 'json' };
import FA from '../../../../config/tests/FA.json' with { type: 'json' };

export interface LoadedConfig {
  session: SessionConfig;
  tests: Map<string, TestConfig>;
  errors: string[];
}

/** Load and validate the bundled configs. The app refuses clinical capture if errors is non-empty. */
export function loadConfig(
  raw: { session: unknown; tests: Record<string, unknown> } = {
    session,
    tests: { FT, FTF, FR, SAW, FA },
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
  return { session: raw.session as SessionConfig, tests, errors };
}
