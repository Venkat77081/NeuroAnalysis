/** M13: the in-app QR scanner decodes invite codes. */
import { describe, expect, it } from 'vitest';
import { decodeQrFrame, deviceCodeFrom } from '../src/lib/qr.ts';
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

describe('clinic-phone registration QR (v29, decision 052)', () => {
  const prefix = 'ncd1:';
  it('reads the code from the dashboard QR (prefix + code)', () => {
    const { data, width, height } = qrRgba('ncd1:K7QX9M4TRA');
    expect(deviceCodeFrom(decodeQrFrame(data, width, height)!, prefix)).toBe('K7QX9M4TRA');
  });
  it('accepts a bare code and tidies case and spaces', () => {
    expect(deviceCodeFrom(' k7qx 9m4tra ', prefix)).toBe('K7QX9M4TRA');
    expect(deviceCodeFrom('NCD1:k7qx9m4tra', prefix)).toBe('K7QX9M4TRA');
  });
  it('rejects other QR codes', () => {
    expect(deviceCodeFrom('ncc1:abcdefabcdef', prefix)).toBeNull(); // clinic consent
    expect(deviceCodeFrom('neurocapture://invite?t=abc', prefix)).toBeNull();
    expect(deviceCodeFrom('https://example.org/x', prefix)).toBeNull();
    expect(deviceCodeFrom('abc', prefix)).toBeNull();
  });
});
