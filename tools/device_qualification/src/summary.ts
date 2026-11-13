/**
 * Validate every report in reports/, re-assess tiers with config/device-tiers.json and write
 * reports/SUMMARY.md.  --check: fail if SUMMARY.md is out of date (CI).
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceTiersConfig } from '@neurocapture/contracts-ts';
import { aggregate, toMarkdown } from './aggregate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const dir = resolve(here, '../reports');
const cfg = JSON.parse(
  readFileSync(join(root, 'config/device-tiers.json'), 'utf8'),
) as DeviceTiersConfig;
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({
    name: `reports/${f}`,
    data: JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown,
  }));

const { rows, errors } = aggregate(files, cfg);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const md = toMarkdown(rows, cfg.configVersion);
const out = join(dir, 'SUMMARY.md');
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== md) {
    console.error(
      'reports/SUMMARY.md is out of date. Run: pnpm --filter @neurocapture/device-qualification summary',
    );
    process.exit(1);
  }
  console.log(`SUMMARY.md up to date (${rows.length} device(s))`);
} else {
  writeFileSync(out, md);
  console.log(`wrote reports/SUMMARY.md (${rows.length} device(s), ${files.length} report(s))`);
}
