import type { TestConfig } from './generated/test-config.ts';
import type { SessionConfig } from './generated/session-config.ts';
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
