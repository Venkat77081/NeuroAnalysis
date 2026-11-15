import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { python, WORK } from './support.ts';

/** Starts the real platform + connector + FHIR stand-in (e2e/stack/run_stack.py). */
export default async function globalSetup() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const proc = spawn(python(), ['e2e/stack/run_stack.py', '--dir', WORK], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const ok = await new Promise<boolean>((res) => {
    const t = setTimeout(() => res(false), 90_000);
    const check = setInterval(() => {
      if (out.includes('ready') && existsSync(`${WORK}/stack.json`)) {
        clearTimeout(t);
        clearInterval(check);
        res(true);
      }
    }, 200);
    proc.on('exit', () => res(false));
  });
  if (!ok) {
    proc.kill();
    throw new Error(`e2e stack did not start:\n${out}`);
  }
  writeFileSync(`${WORK}/pid`, String(proc.pid));
  return () => {
    proc.kill('SIGTERM');
  };
}
