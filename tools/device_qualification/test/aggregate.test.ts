import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchmarkReport, DeviceTiersConfig } from '@neurocapture/contracts-ts';
import { aggregate, toMarkdown } from '../src/aggregate.ts';

const root = resolve(import.meta.dirname, '../../..');
const cfg = JSON.parse(
  readFileSync(resolve(root, 'config/device-tiers.json'), 'utf8'),
) as DeviceTiersConfig;
const sample = JSON.parse(
  readFileSync(
    resolve(root, 'contracts/tests/valid/benchmark-report/native-tier-a-1.0.0.json'),
    'utf8',
  ),
) as BenchmarkReport;

describe('aggregate', () => {
  it('groups by device and re-assesses tiers, ignoring stored assessments', () => {
    const slow = structuredClone(sample);
    slow.device.model = 'Example Slow';
    slow.recording.effectiveFps = 30;
    slow.assessment = {
      tier: 'A',
      provisional: false,
      reasons: [],
      tiersConfigVersion: 'TIERS@1.0.0',
    }; // wrong on purpose
    const slow30 = structuredClone(slow);
    slow30.settings.targetFps = 30;
    slow30.recording.effectiveFps = 29.9;
    const { rows, errors } = aggregate(
      [
        { name: 'a.json', data: sample },
        { name: 'b.json', data: slow },
        { name: 'c.json', data: slow30 },
      ],
      cfg,
    );
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.device, r.tier, r.runs])).toEqual([
      ['ExampleCo Example X1', 'A', 1],
      ['ExampleCo Example Slow', 'B', 2],
    ]);
    expect(rows[1]!.best30).toBe('29.9 fps, 0.17% drop');
    const md = toMarkdown(rows, cfg.configVersion);
    expect(md).toContain('| ExampleCo Example Slow | android 15 | 2 | B |');
  });

  it('reports invalid files by field, and renders an empty table', () => {
    const { rows, errors } = aggregate(
      [{ name: 'bad.json', data: { schemaVersion: '1.0.0' } }],
      cfg,
    );
    expect(rows).toEqual([]);
    expect(errors[0]).toContain('bad.json: field "/implementation"');
    expect(toMarkdown([], 'TIERS@1.0.0')).toContain('_no reports yet_');
  });
});
