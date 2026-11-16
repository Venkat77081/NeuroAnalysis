/** M13: the in-app QR scanner decodes invite codes. */
import { describe, expect, it } from 'vitest';
import { decodeQrFrame } from '../src/lib/qr.ts';
import { inviteToken } from '../src/lib/accounts.ts';
import { qrRgba } from '../e2e/support/qr-video.ts';

describe('QR decode (M13)', () => {
  it('reads an invite link from a QR code and finds its token', () => {
    const link = 'neurocapture://invite?t=Xy7_abcDEF0123456789-k';
    const { data, width, height } = qrRgba(link);
    const text = decodeQrFrame(data, width, height);
    expect(text).toBe(link);
    expect(inviteToken(text!)).toBe('Xy7_abcDEF0123456789-k');
  });

  it('returns null when there is no code', () => {
    const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(decodeQrFrame(blank, 200, 200)).toBeNull();
  });
});
