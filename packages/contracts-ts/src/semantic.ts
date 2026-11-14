import type { TestConfig } from './generated/test-config.ts';
import type { SessionConfig } from './generated/session-config.ts';
import type { QualityConfig } from './generated/quality-config.ts';
import type { BiomarkerRegistry } from './generated/biomarker-registry.ts';
import type { ValidationIssue } from './validate.ts';

/**
 * Cross-field and cross-file rules JSON Schema cannot express.
 * Run after schema validation passed.
 */
export function checkTestConfig(cfg: TestConfig, fileStem?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (fileStem !== undefined && fileStem !== cfg.code) {
    issues.push({
      path: '/code',
      message: `is "${cfg.code}" but the file is named ${fileStem}.json`,
    });
  }
  if (!cfg.configVersion.startsWith(`${cfg.code}@`)) {
    issues.push({ path: '/configVersion', message: `must start with "${cfg.code}@"` });
  }
  const [dMin, dMax] = cfg.setup.distanceM;
  if (dMin >= dMax) issues.push({ path: '/setup/distanceM', message: 'min must be less than max' });
  if (cfg.framing.subjectSize.min >= cfg.framing.subjectSize.max) {
    issues.push({ path: '/framing/subjectSize', message: 'min must be less than max' });
  }
  const dp = cfg.task.detectorParams;
  if (dp && dp !== 'TBD') {
    const common = ['minCutoff', 'beta', 'motionThreshold', 'motionWindowS'];
    const byDetector: Record<string, string[]> = {
      tap_counter: ['minProminence', 'minDistanceS', 'minEvents'],
      rotation_counter: ['minProminence', 'minDistanceS', 'minEvents'],
      ftf_cycle_counter: ['minProminence', 'minDistanceS', 'minEvents'],
      saw_phases: ['standRiseFrac', 'walkMinSpeed', 'minTurns'],
      expression_sequence: [
        'browKeys',
        'smileKeys',
        'minPeak',
        'minProminence',
        'minDistanceS',
        'minEach',
      ],
    };
    const missing = [...common, ...(byDetector[cfg.task.detector] ?? [])].filter((k) => !(k in dp));
    if (missing.length)
      issues.push({
        path: '/task/detectorParams',
        message: `missing for ${cfg.task.detector}: ${missing.join(', ')}`,
      });
  }
  const allowed = cfg.camera.allowedOrientations;
  if (allowed && !allowed.includes(cfg.camera.orientation)) {
    issues.push({
      path: '/camera/allowedOrientations',
      message: `must include the default orientation "${cfg.camera.orientation}"`,
    });
  }
  if (cfg.camera.minEffectiveFps > cfg.camera.targetFps) {
    issues.push({ path: '/camera/minEffectiveFps', message: 'must not exceed targetFps' });
  }
  if (Array.isArray(cfg.biomarkers)) {
    const bad = cfg.biomarkers.filter((b) => !new RegExp(`^${cfg.code}[0-9]+$`).test(b));
    if (bad.length)
      issues.push({
        path: '/biomarkers',
        message: `IDs must belong to ${cfg.code}: ${bad.join(', ')}`,
      });
  }
  for (const t of Object.keys(cfg.framing.requiredLandmarks)) {
    if (!cfg.trackers.includes(t as 'hand' | 'pose' | 'face')) {
      issues.push({
        path: `/framing/requiredLandmarks/${t}`,
        message: `needs tracker "${t}" in /trackers`,
      });
    }
  }
  if (cfg.framing.handednessMustMatchSide && cfg.sides.length === 0) {
    issues.push({ path: '/framing/handednessMustMatchSide', message: 'requires a sided test' });
  }
  return issues;
}

export function checkSessionConfig(
  session: SessionConfig,
  tests: Map<string, TestConfig>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  session.order.forEach((entry, i) => {
    const [code, side] = entry;
    const cfg = tests.get(code);
    if (!cfg) {
      issues.push({
        path: `/order/${i}/0`,
        message: `test "${code}" has no config in config/tests/`,
      });
      return;
    }
    const sided = cfg.sides.length > 0;
    if (sided && (side === null || !cfg.sides.includes(side))) {
      issues.push({
        path: `/order/${i}/1`,
        message: `must be one of ${cfg.sides.join(', ')} for ${code}`,
      });
    }
    if (!sided && side !== null) {
      issues.push({ path: `/order/${i}/1`, message: `must be null; ${code} is not sided` });
    }
  });
  return issues;
}

/** Cross-field rules for config/quality.json that JSON Schema cannot express. */
export function checkQualityConfig(cfg: QualityConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const e = cfg.engine;
  if (e.warnExitFrac >= e.warnEnterFrac) {
    issues.push({
      path: '/engine/warnExitFrac',
      message: 'must be below warnEnterFrac (hysteresis)',
    });
  }
  const b = cfg.checks.brightness;
  if (b.lumaMin >= b.lumaMax)
    issues.push({ path: '/checks/brightness', message: 'lumaMin must be below lumaMax' });
  const f = cfg.checks.face_light_balance;
  if (f.min >= f.max)
    issues.push({ path: '/checks/face_light_balance', message: 'min must be below max' });
  return issues;
}

/**
 * Biomarker registry (M8): unique IDs whose prefix is the test code; every ID a test config
 * lists is registered and vice versa; required trackers are recorded by that test.
 */
export function checkBiomarkerRegistry(
  reg: BiomarkerRegistry,
  tests: Map<string, TestConfig>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  reg.biomarkers.forEach((b, i) => {
    const at = `/biomarkers/${i}`;
    if (seen.has(b.id)) issues.push({ path: `${at}/id`, message: `duplicate id ${b.id}` });
    seen.add(b.id);
    if (!new RegExp(`^${b.testCode}[0-9]+$`).test(b.id))
      issues.push({ path: `${at}/id`, message: `id ${b.id} does not start with ${b.testCode}` });
    const test = tests.get(b.testCode);
    if (!test) return;
    for (const t of b.inputs.trackers ?? [])
      if (!test.trackers.includes(t))
        issues.push({
          path: `${at}/inputs/trackers`,
          message: `${b.testCode} does not record ${t}`,
        });
    for (const t of Object.keys(b.inputs.landmarks ?? {}))
      if (!test.trackers.includes(t as 'hand' | 'pose' | 'face'))
        issues.push({
          path: `${at}/inputs/landmarks`,
          message: `${b.testCode} does not record ${t}`,
        });
  });
  for (const [code, test] of tests)
    for (const id of test.biomarkers ?? [])
      if (!seen.has(id))
        issues.push({
          path: '/biomarkers',
          message: `${code} lists ${id}, which is not registered`,
        });
  for (const id of seen) {
    const code = id.replace(/[0-9]+$/, '');
    const test = tests.get(code);
    if (test && !(test.biomarkers ?? []).includes(id))
      issues.push({
        path: '/biomarkers',
        message: `${id} is registered but ${code} does not list it`,
      });
  }
  return issues;
}
