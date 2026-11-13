/** Writes contracts/tests/golden/{frames,sensors}-1.0.0.bin. The Kotlin writer must reproduce them byte for byte. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamHeader } from '@neurocapture/contracts-ts/types';
import { encodeFrames, encodeSensors } from '../src/streams.ts';
import { goldenFrames, goldenSensors } from '../test/golden-records.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const header = (n: string) =>
  JSON.parse(
    readFileSync(resolve(root, `contracts/tests/valid/stream-header/${n}-1.0.0.json`), 'utf8'),
  ) as StreamHeader;
writeFileSync(
  resolve(root, 'contracts/tests/golden/frames-1.0.0.bin'),
  encodeFrames(header('frames'), goldenFrames),
);
writeFileSync(
  resolve(root, 'contracts/tests/golden/sensors-1.0.0.bin'),
  encodeSensors(header('sensors'), goldenSensors),
);
console.log('wrote contracts/tests/golden/{frames,sensors}-1.0.0.bin');
