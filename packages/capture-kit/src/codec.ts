/** Binary landmark packing used on the bridge: little-endian Float32 → base64 (DEV_PLAN §5.3). */

export function encodeFloat32(values: ArrayLike<number>): string {
  const f32 = Float32Array.from(values as ArrayLike<number>);
  const bytes = new Uint8Array(f32.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function decodeFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  if (bin.length % 4 !== 0)
    throw new Error(`landmark payload length ${bin.length} is not a multiple of 4`);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Bytes → base64 (bridge transport of binary files such as landmarks.bin). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
