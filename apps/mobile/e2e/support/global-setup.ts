import { mkdirSync } from 'node:fs';
import { writeQrY4m } from './qr-video.ts';
import platform from '../../../../config/platform.json' with { type: 'json' };

/** The fake camera for the QR scanner test shows this invite (the fake server accepts it). */
export const QR_INVITE_TOKEN = 'e2e-qr-invite-token-0001';
export const QR_VIDEO = 'test-results/qr-invite.y4m';
/** v29: the clinic-phone registration QR (config prefix + the code the fake server accepts). */
export const QR_DEVICE_VIDEO = 'test-results/qr-device.y4m';

export default function globalSetup() {
  mkdirSync('test-results', { recursive: true });
  writeQrY4m(QR_VIDEO, `neurocapture://invite?t=${QR_INVITE_TOKEN}`);
  writeQrY4m(QR_DEVICE_VIDEO, `${platform.invites.deviceQrPrefix}DEMO-SITE-1`);
}
