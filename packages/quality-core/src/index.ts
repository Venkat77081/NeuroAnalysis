export * from './types.ts';
export { QUALITY_CORE_VERSION } from './version.ts';
export { makeRuleId, parseRuleId, type ParsedRuleId } from './rule-id.ts';
export { parseNs, secondsBetween, meetsDuration } from './time.ts';
export {
  assignTier,
  allowedTests,
  formatTierReason,
  type Tier,
  type TierAssessment,
  type TierReason,
  type TierReasonCode,
} from './device/tier.ts';
export {
  captureVerdict,
  type CaptureVerdict,
  type TakeFacts,
  type VerdictConfig,
  type VerdictReason,
  type VerdictReasonCode,
  type AnalysisFacts,
} from './verdict/capture.ts';
export { SeverityLog, analyseTake, type TakeAnalysis, type TakeEvent } from './verdict/analysis.ts';
export * from './checks/checks.ts';
export {
  AnalysisHealth,
  SensorBuffer,
  evaluateFrame,
  gateRules,
  type CheckContext,
} from './checks/evaluate.ts';
export {
  GuidanceEngine,
  fallbackKey,
  lowFpsCritical,
  type GuidanceState,
  type Prompt,
  type RuleView,
  type WindowState,
} from './engine/guidance.ts';
export {
  SYNTHETIC_SHARPNESS_BASELINE,
  scenariosFor,
  syntheticFrame,
  type Expectation,
  type ScenarioName,
  type SyntheticOptions,
  type SyntheticSample,
} from './synthetic.ts';
export {
  OneEuroFilter,
  findPeaks,
  motionWindows,
  oneEuro,
  rollingRange,
  savitzkyGolay,
  speed,
  type Peak,
  type Window,
} from './detectors/signal.ts';
export {
  runDetector,
  type DetectorEvent,
  type DetectorEventKind,
  type DetectorName,
  type DetectorParams,
  type DetectorResult,
  type FaceParams,
  type PeakParams,
  type SawParams,
} from './detectors/detectors.ts';
export {
  syntheticTake,
  type SyntheticTake,
  type TakeVariant,
  type TruthEvent,
} from './synthetic-takes.ts';
export {
  QUALITY_RULES_FOR,
  RETAKE_FIXABLE,
  landmarkVisibleFrac,
  readinessHint,
  readinessRetakeReasons,
  type MissingInput,
  type ReadinessEvidence,
  type ReadinessHint,
  type ReadinessItem,
  type ReadinessStatus,
} from './verdict/readiness.ts';
export {
  evaluateRecordedTake,
  type RecordedTakeEvaluation,
  type RecordedTakeInput,
} from './verdict/recorded.ts';
