import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.ts';

describe('loadConfig', () => {
  it('loads the bundled configs without errors', () => {
    const c = loadConfig();
    expect(c.errors).toEqual([]);
    expect(c.tests.size).toBe(5);
    expect(c.session.order).toHaveLength(8);
  });
  it('reports the field of an invalid config', () => {
    const c = loadConfig({
      session: { schemaVersion: '1.0.0' },
      tests: { FT: { schemaVersion: '1.0.0' } },
    });
    expect(c.errors.some((e) => e.startsWith('tests/FT.json /configVersion'))).toBe(true);
    expect(c.errors.some((e) => e.startsWith('session.json /order'))).toBe(true);
  });
});
