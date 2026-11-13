/**
 * Generate TypeScript types from /contracts/*.schema.json into src/generated/.
 *   tsx scripts/gen.ts          write files
 *   tsx scripts/gen.ts --check  fail if generated files are out of date (CI)
 */
import { compile } from 'json-schema-to-typescript';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemas } from '../src/schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../src/generated');
const check = process.argv.includes('--check');
const banner =
  '/* eslint-disable */\n/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */\n';

mkdirSync(outDir, { recursive: true });
const files: Record<string, string> = {};
for (const [name, schema] of Object.entries(schemas)) {
  const ts = await compile(structuredClone(schema) as never, name, {
    bannerComment: banner,
    additionalProperties: false,
    unreachableDefinitions: false,
    style: { singleQuote: true, printWidth: 100 },
  });
  files[`${name}.ts`] = ts;
}
files['index.ts'] =
  banner +
  Object.keys(schemas)
    .map((n) => `export type * from './${n}.ts';`)
    .join('\n') +
  '\n';

let stale = 0;
for (const [f, content] of Object.entries(files)) {
  const p = join(outDir, f);
  if (check) {
    if (!existsSync(p) || readFileSync(p, 'utf8') !== content) {
      console.error(`out of date: src/generated/${f}`);
      stale++;
    }
  } else {
    writeFileSync(p, content);
    console.log(`wrote src/generated/${f}`);
  }
}
if (stale) {
  console.error('Run `pnpm contracts:gen` and commit the result.');
  process.exit(1);
}
