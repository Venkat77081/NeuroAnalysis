#!/usr/bin/env node
/**
 * Download the MediaPipe models listed in models.json, verify SHA-256, and place them where the
 * Android app (assets/mediapipe) and the web app (public/mediapipe) load them. Idempotent: files
 * with the right hash are kept. Exits non-zero on any mismatch.
 *   node tools/models/fetch-models.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const cache = join(here, '.cache');
const targets = [
  join(root, 'apps/mobile/android/app/src/main/assets/mediapipe'),
  join(root, 'apps/mobile/public/mediapipe'),
];
const { models } = JSON.parse(readFileSync(join(here, 'models.json'), 'utf8'));

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
mkdirSync(cache, { recursive: true });
for (const t of targets) mkdirSync(t, { recursive: true });

let failed = 0;
for (const m of models) {
  const cached = join(cache, m.name);
  const ok = existsSync(cached) && sha(readFileSync(cached)) === m.sha256;
  if (!ok) {
    process.stdout.write(`downloading ${m.name} … `);
    const res = await fetch(m.url);
    if (!res.ok) {
      console.error(`HTTP ${res.status}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== m.sha256) {
      console.error(`SHA-256 mismatch (got ${sha(buf)})`);
      failed++;
      continue;
    }
    writeFileSync(cached, buf);
    console.log(`${buf.length} bytes, verified`);
  } else {
    console.log(`${m.name} cached, verified`);
  }
  for (const t of targets) copyFileSync(cached, join(t, m.name));
}
// MediaPipe WASM runtime for the browser webcam mode (Tier W), served from public/mediapipe/wasm.
const wasm = join(root, 'packages/capture-kit/node_modules/@mediapipe/tasks-vision/wasm');
if (existsSync(wasm)) {
  cpSync(wasm, join(root, 'apps/mobile/public/mediapipe/wasm'), { recursive: true });
  console.log('copied MediaPipe WASM runtime to apps/mobile/public/mediapipe/wasm');
} else {
  console.warn(
    'MediaPipe WASM runtime not found (run pnpm install first); webcam mode will not track',
  );
}
if (failed) {
  console.error(`${failed} model(s) failed`);
  process.exit(1);
}
