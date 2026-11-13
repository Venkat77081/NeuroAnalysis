#!/usr/bin/env -S npx tsx
/**
 * nc-validate — validate JSON files against the NeuroCapture contracts.
 *
 *   nc-validate <schema> <file...>   validate files against one schema
 *   nc-validate --all                validate config/ and contracts/tests/ (CI)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSchemaName, schemaNames, type SchemaName } from './schemas.ts';
import { validate, formatIssues, type ValidationIssue } from './validate.ts';
import { checkSessionConfig, checkTestConfig } from './semantic.ts';
import type { TestConfig } from './generated/test-config.ts';
import type { SessionConfig } from './generated/session-config.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function rel(file: string): string {
  return file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file;
}

let failures = 0;
function report(file: string, issues: ValidationIssue[]): void {
  if (issues.length) {
    failures++;
    console.error(formatIssues(rel(file), issues));
  } else {
    console.log(`ok   ${rel(file)}`);
  }
}

function validateFile(schema: SchemaName, file: string): ValidationIssue[] {
  try {
    return validate(schema, readJson(file)).issues;
  } catch (e) {
    return [{ path: '', message: `could not be read as JSON: ${(e as Error).message}` }];
  }
}

function runAll(): void {
  // 1. Test configs (schema + semantic rules)
  const testsDir = join(repoRoot, 'config/tests');
  const tests = new Map<string, TestConfig>();
  for (const f of readdirSync(testsDir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const file = join(testsDir, f);
    const issues = validateFile('test-config', file);
    if (!issues.length) {
      const cfg = readJson(file) as TestConfig;
      issues.push(...checkTestConfig(cfg, basename(f, '.json')));
      tests.set(cfg.code, cfg);
    }
    report(file, issues);
  }
  // 2. Session config
  const sessionFile = join(repoRoot, 'config/session.json');
  const sIssues = validateFile('session-config', sessionFile);
  if (!sIssues.length)
    sIssues.push(...checkSessionConfig(readJson(sessionFile) as SessionConfig, tests));
  report(sessionFile, sIssues);
  // 2b. Device tier thresholds
  const tiersFile = join(repoRoot, 'config/device-tiers.json');
  report(tiersFile, validateFile('device-tiers', tiersFile));

  // 3. Compatibility samples: valid must pass
  const samples = join(repoRoot, 'contracts/tests');
  for (const schema of schemaNames) {
    const dir = join(samples, 'valid', schema);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      report(join(dir, f), validateFile(schema, join(dir, f)));
    }
  }
  // 4. Invalid samples must fail and name the expected field
  const expected = readJson(join(samples, 'invalid/expected.json')) as Record<string, string>;
  for (const [key, field] of Object.entries(expected)) {
    if (key.startsWith('_')) continue;
    const [schema] = key.split('/');
    const file = join(samples, 'invalid', key);
    if (!schema || !isSchemaName(schema)) {
      report(file, [{ path: '', message: `unknown schema folder "${schema}"` }]);
      continue;
    }
    const issues = validateFile(schema, file);
    if (!issues.length) {
      report(file, [{ path: '', message: 'should be INVALID but passed validation' }]);
    } else if (!issues.some((i) => i.path === field)) {
      report(file, [
        {
          path: '',
          message: `failed, but no error names ${field}; got ${issues.map((i) => i.path).join(', ')}`,
        },
      ]);
    } else {
      console.log(
        `ok   ${rel(file)} (rejected: ${formatIssues(
          '',
          issues.filter((i) => i.path === field),
        ).slice(2)})`,
      );
    }
  }
}

function main(argv: string[]): void {
  if (argv[0] === '--all') {
    runAll();
  } else if (argv.length >= 2 && argv[0] && isSchemaName(argv[0])) {
    const schema = argv[0];
    for (const f of argv.slice(1)) report(resolve(f), validateFile(schema, resolve(f)));
  } else {
    console.error(
      `usage: nc-validate <${schemaNames.join('|')}> <file...>\n       nc-validate --all`,
    );
    process.exit(2);
  }
  if (failures) {
    console.error(`\n${failures} file(s) failed validation`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
