/** Writes contracts/tests/golden/landmarks-1.0.0.bin; the Kotlin writer must reproduce it byte for byte. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LandmarksHeader } from '@neurocapture/contracts-ts/types';
import { encodeLandmarks } from '../src/landmarks.ts';
import { goldenLandmarkRecords } from '../test/golden-landmarks.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const header = JSON.parse(
  readFileSync(resolve(root, 'contracts/tests/valid/landmarks-header/golden-1.0.0.json'), 'utf8'),
) as LandmarksHeader;
writeFileSync(
  resolve(root, 'contracts/tests/golden/landmarks-1.0.0.bin'),
  encodeLandmarks(header, goldenLandmarkRecords),
);
console.log('wrote contracts/tests/golden/landmarks-1.0.0.bin');
