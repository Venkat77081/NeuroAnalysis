/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * M15 (decision 057): biomarker analysis at the hospital. Keypoint models (open source, Apache 2.0), detection thresholds, pre-processing (gap fill, median and Savitzky-Golay filters) and cycle detection. Schema version 1.0.0.
 */
export interface AnalysisConfig {
  schemaVersion: '1.0.0';
  analysisVersion: string;
  models: {
    hand: {
      name: string;
      url: string;
    };
    pose: {
      name: string;
      url: string;
    };
    face: {
      name: string;
      url: string;
    };
  };
  detection: {
    maxHands: number;
    minDetectionConfidence: number;
    minPresenceConfidence: number;
    minTrackingConfidence: number;
  };
  /**
   * Gaps up to maxGapS are filled by linear interpolation; longer gaps stay missing. Then a median filter (odd kernel, frames) and a Savitzky-Golay filter (window in seconds, polynomial order).
   */
  preprocess: {
    maxGapS: number;
    medianKernel: number;
    savgolWindowS: number;
    savgolOrder: number;
  };
  /**
   * A cycle runs from one minimum to the next. Minima need a prominence of at least minProminenceFrac of the signal's 5-95 % range and at least minPeriodS apart; fewer than minCycles cycles makes the biomarker NOT_COMPUTABLE.
   */
  cycles: {
    minProminenceFrac: number;
    minPeriodS: number;
    minCycles: number;
  };
  /**
   * Share of frames in which the needed keypoints must be found (after gap filling).
   */
  minValidFrac: number;
  /**
   * Stand and Walk: walking and turning segments from the pelvis's forward speed; steps from the ankle distance.
   */
  saw: {
    /**
     * Walking where the pelvis's forward speed is at least this share of its 90th percentile.
     */
    walkSpeedFrac: number;
    /**
     * …and at least this many trunk lengths per second.
     */
    minWalkSpeed: number;
    /**
     * Shortest walking segment, s.
     */
    minWalkS: number;
    /**
     * Shortest time between two steps, s.
     */
    minStepS: number;
    /**
     * A step's ankle-distance peak stands out by at least this share of the segment's range.
     */
    stepProminenceFrac: number;
    /**
     * Fewest steps in the walking segments for the step measures.
     */
    minSteps: number;
  };
}
