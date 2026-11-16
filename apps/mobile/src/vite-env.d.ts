/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_PRODUCTION?: string;
  /** The NeuroCapture API address built into release apps (see lib/server.ts). */
  readonly VITE_SERVER_URL?: string;
}
