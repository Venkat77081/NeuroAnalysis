#!/usr/bin/env tsx
/**
 * nc-replay — recompute take verdicts from saved evidence and check parity with the phone (M8).
 *
 *   pnpm replay <dir> [<dir> …] [--config <configDir>] [--check] [--write] [--json]
 *
 * <dir> is a take directory or a folder of take directories (any folder with a quality.json).
 * --check  exit 1 unless every take matches the phone exactly
 * --write  write replay-quality.json next to each quality.json
 * --json   print the full results as JSON
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTakeDirs, loadConfig, replayTakeDir, type ReplayResult } from './replay.ts';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configDir = resolve(opt('--config') ?? join(repo, 'config'));
const roots = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--config');
if (!roots.length) {
  console.error('usage: nc-replay <takeDir|folder>… [--config dir] [--check] [--write] [--json]');
  process.exit(2);
}

const config = loadConfig(configDir);
const results: ReplayResult[] = [];
for (const root of roots)
  for (const dir of findTakeDirs(root)) {
    const r = replayTakeDir(dir, config);
    results.push(r);
    if (flag('--write'))
      writeFileSync(join(dir, 'replay-quality.json'), JSON.stringify(r.quality, null, 2));
  }

if (flag('--json'))
  console.log(
    JSON.stringify(
      results.map(({ quality: _quality, ...r }) => r),
      null,
      2,
    ),
  );
else {
  for (const r of results) {
    console.log(
      `${r.parity.padEnd(16)} ${r.testCode.padEnd(4)} device ${r.deviceVerdict.padEnd(7)} replay ${r.replayVerdict.padEnd(7)} ${relative(process.cwd(), r.dir)}`,
    );
    for (const d of r.differences) console.log(`    ${d}`);
  }
  const n = (p: string) => results.filter((r) => r.parity === p).length;
  console.log(
    `\n${results.length} takes: ${n('match')} match, ${n('mismatch')} mismatch, ${n('input_mismatch')} input mismatch, ${n('version_mismatch')} version mismatch, ${n('no_inputs')} without replay inputs`,
  );
}
if (flag('--check') && results.some((r) => r.parity !== 'match')) process.exit(1);
