import type { AnalysisFrameEvent, SensorBatchEvent } from './definitions.ts';

/**
 * A replayable capture fixture: analysis events + sensor batches with timestamps relative
 * to the start of the fixture. Used by MockCaptureKit, Playwright and (M8) the replay tool.
 */
export interface CaptureFixture {
  format: 'neurocapture-fixture@1';
  name: string;
  testCode: 'FT' | 'FTF' | 'FR' | 'SAW' | 'FA';
  side: 'R' | 'L' | null;
  synthetic: boolean;
  fps: number;
  durationS: number;
  frames: AnalysisFrameEvent[];
  sensorBatches: (SensorBatchEvent & { tsNs: string })[];
}
