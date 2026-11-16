/**
 * Which NeuroCapture server the app talks to (v8, user 16 Nov 2026: "in production do we need to
 * enter the server address?" No). Release builds (VITE_PRODUCTION=1) have the address built in:
 * VITE_SERVER_URL at build time, else config/session.json `upload.defaultEndpoint`; no one types it.
 * Debug and browser builds still show the field, for testing against a computer on the Wi-Fi.
 */
import type { LoadedConfig } from './config.ts';

export const SERVER_FIELD_SHOWN = import.meta.env.VITE_PRODUCTION !== '1';

export function builtInServer(config: LoadedConfig): string {
  return import.meta.env.VITE_SERVER_URL || config.session.upload?.defaultEndpoint || '';
}
