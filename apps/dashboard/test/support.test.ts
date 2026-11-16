import { describe, expect, it } from 'vitest';
import { totp } from '../e2e/support.ts';
import { ApiError } from '../src/api.ts';

describe('dashboard helpers', () => {
  it('two-step codes match RFC 6238 (SHA-1 test vector, 6 digits)', () => {
    // Secret "12345678901234567890" in base32; at T = 59 s the 8-digit code is 94287082.
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
  });
  it('API errors carry the server code', () => {
    const e = new ApiError(403, 'account_locked');
    expect([e.status, e.code, e.message]).toEqual([403, 'account_locked', 'account_locked']);
  });
});
