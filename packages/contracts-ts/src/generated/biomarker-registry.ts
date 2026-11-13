/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * Biomarker IDs and their input requirements (DEV_PLAN §10, M8). formula stays null until defined. Schema version 1.0.0.
 */
export interface BiomarkerRegistry {
  schemaVersion: '1.0.0';
  registryVersion: string;
  biomarkers: {
    id: string;
    testCode: 'FT' | 'FTF' | 'FR' | 'SAW' | 'FA';
    family: string;
    formula: string | null;
    formulaVersion: string | null;
    inputs: {
      minEffectiveFps?: number;
      minDurationS?: number;
      trackers?: ('hand' | 'pose' | 'face')[];
      landmarks?: {
        [k: string]: number[];
      };
      minLandmarkVisibleFrac?: number;
      requiresSensors?: boolean;
      requiresPhases?: string[];
    };
  }[];
}
