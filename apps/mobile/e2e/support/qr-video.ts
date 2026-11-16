/** Renders a QR code to RGBA pixels, and to a Y4M video that Chromium uses as a fake camera. */
import QRCode from 'qrcode';
import { writeFileSync } from 'node:fs';

export function qrRgba(
  text: string,
  size = 360,
): { data: Uint8ClampedArray; width: number; height: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const cell = Math.floor(size / (n + quiet * 2));
  const width = cell * (n + quiet * 2);
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < cell; dy++)
        for (let dx = 0; dx < cell; dx++) {
          const i = (((y + quiet) * cell + dy) * width + (x + quiet) * cell + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
  return { data, width, height: width };
}

/** A 2-second Y4M (4:2:0, 5 fps) showing the QR code on white, for --use-file-for-fake-video-capture. */
export function writeQrY4m(path: string, text: string, frameW = 640, frameH = 480): void {
  const { data, width } = qrRgba(text, 400);
  const yPlane = Buffer.alloc(frameW * frameH, 235);
  const ox = Math.floor((frameW - width) / 2);
  const oy = Math.floor((frameH - width) / 2);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++)
      yPlane[(y + oy) * frameW + x + ox] = data[(y * width + x) * 4]! ? 235 : 16;
  const chroma = Buffer.alloc((frameW / 2) * (frameH / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), yPlane, chroma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${frameW} H${frameH} F5:1 Ip A1:1 C420jpeg\n`);
  writeFileSync(path, Buffer.concat([header, ...Array.from({ length: 10 }, () => frame)]));
}
