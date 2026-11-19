import { describe, expect, it } from 'vitest';
import { stepLength } from '../src/session/machine.ts';
import { loadConfig } from '../src/lib/config.ts';

/** v31 (decision 054): each take records for the request's length; else the test config's. */
describe('take length per plan step', () => {
  const config = loadConfig();
  it('uses the request’s length when it has one', () => {
    const ft = config.tests.get('FT')!;
    expect(stepLength({ code: 'FT', side: null, durationS: 20 } as never, ft)).toBe(20);
    expect(stepLength({ code: 'FT', side: null } as never, ft)).toBe(ft.task.durationS);
  });
  it('the config offers the default and longer lengths only', () => {
    for (const [, cfg] of config.tests) {
      const opts = (cfg.task as { durationOptionsS?: number[] }).durationOptionsS ?? [];
      expect(opts).toContain(cfg.task.durationS);
      expect(Math.min(...opts)).toBe(cfg.task.durationS);
    }
  });
});
