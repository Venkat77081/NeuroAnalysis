/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * M15 (decision 057): the biomarkers of one take, computed at the hospital from the 60 fps video. Decision support, not a diagnosis. Holds no patient identity. Schema version 1.0.0.
 */
export interface BiomarkerResult {
  schemaVersion: '1.0.0';
  analysisVersion: string;
  registryVersion: string;
  testCode: 'FT' | 'FTF' | 'FR' | 'SAW' | 'FA';
  keypoints: {
    library: string;
    version: string;
    models: string[];
  };
  frames: {
    count: number;
    fps: number;
    durationS: number;
  };
  biomarkers: {
    id: string;
    status: 'COMPUTED' | 'NOT_COMPUTABLE' | 'NOT_IMPLEMENTED';
    value: number | null;
    unit?: string;
    cycles?: number;
    reason?: string;
  }[];
}
