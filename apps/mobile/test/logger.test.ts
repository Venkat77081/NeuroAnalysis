import { describe, expect, it } from 'vitest';
import { createLogger, redact, redactString, type Level } from '../src/lib/logger.ts';

describe('PII-safe logger', () => {
  it('drops sensitive keys at any depth', () => {
    expect(redact({ patientName: 'Asha', nested: { external_ref: 'X1', ok: 1 }, lm: 'AAAA' })).toEqual({
      patientName: '[redacted]',
      nested: { external_ref: '[redacted]', ok: 1 },
      lm: '[redacted]',
    });
  });
  it('masks emails, base64 blobs and long numbers inside strings', () => {
    expect(redactString('mail a.b@c.io blob ' + 'A'.repeat(48) + ' id 1234567')).toBe('mail [email] blob [blob] id [number]');
  });
  it('summarizes large arrays (landmark streams) and limits depth', () => {
    expect(redact({ xs: new Array(100).fill(0) })).toEqual({ xs: '[array(100)]' });
    expect(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toEqual({ a: { b: { c: { d: { e: '[depth]' } } } } });
  });
  it('passes safe values through and redacts the message', () => {
    const out: [Level, string, Record<string, unknown>][] = [];
    const log = createLogger((l, m, f) => out.push([l, m, f]));
    log.info('take 9876543 done', { fps: 59.8, ok: true, tags: ['a'] });
    log.error('x');
    expect(out).toEqual([
      ['info', 'take [number] done', { fps: 59.8, ok: true, tags: ['a'] }],
      ['error', 'x', {}],
    ]);
  });
});
