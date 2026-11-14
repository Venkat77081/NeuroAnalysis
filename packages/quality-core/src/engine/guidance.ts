/**
 * Rule engine (DEV_PLAN §9.3): a sliding window per rule, hysteresis between OK and WARN,
 * UNKNOWN when most input was unavailable, the Record gate, one prompt at a time by priority,
 * a per-prompt speech cooldown, and severity (INFO / WARN / CRITICAL) for use during recording.
 * Pure and clock-free: time is the canonical frame time passed in.
 */
import type { QualityConfig } from '@neurocapture/contracts-ts';
import { parseRuleId } from '../rule-id.ts';
import type { CheckSample, PromptKey, RuleName, Severity } from '../types.ts';

export type WindowState = 'OK' | 'WARN' | 'UNKNOWN';

export interface RuleView {
  rule: RuleName;
  state: WindowState;
  /** Fraction of known samples in the window that failed. */
  badFrac: number;
  hint: PromptKey | null;
}

export interface Prompt {
  rule: RuleName;
  key: PromptKey;
}

export interface GuidanceState {
  rules: RuleView[];
  /** Every gate rule OK continuously for gateHoldS. */
  gateOpen: boolean;
  /** 0..1 progress of the gate hold (1 = open). */
  gateProgress: number;
  /** True only on the update where the gate opened (lock AE/AF/AWB, haptic). */
  gateJustOpened: boolean;
  /** The single prompt to show, by priority; null when nothing fails. */
  prompt: Prompt | null;
  /** Some rule is UNKNOWN and nothing fails: show a neutral "tracking…". */
  tracking: boolean;
}

const MS = 1_000_000n;

interface Track {
  samples: CheckSample[];
  state: WindowState;
  okSince: bigint | null;
  warnSince: bigint | null;
  hint: PromptKey | null;
}

export class GuidanceEngine {
  private readonly tracks = new Map<RuleName, Track>();
  private readonly priority: RuleName[];
  private readonly windowNs: bigint;
  private readonly holdNs: bigint;
  private gateWasOpen = false;
  private lastSpoken = new Map<PromptKey, bigint>();

  constructor(
    readonly rules: readonly RuleName[],
    private readonly cfg: QualityConfig,
  ) {
    for (const r of rules)
      this.tracks.set(r, {
        samples: [],
        state: 'UNKNOWN',
        okSince: null,
        warnSince: null,
        hint: null,
      });
    const listed = cfg.guidance.promptPriority as RuleName[];
    this.priority = [
      ...listed.filter((r) => rules.includes(r)),
      ...rules.filter((r) => !listed.includes(r)),
    ];
    this.windowNs = BigInt(Math.round(cfg.engine.windowMs)) * MS;
    this.holdNs = BigInt(Math.round(cfg.engine.gateHoldS * 1000)) * MS;
  }

  /** Add check samples (any rules not in the engine are ignored). */
  push(samples: readonly CheckSample[]): void {
    for (const s of samples) {
      const name = parseRuleId(s.ruleId)?.name as RuleName | undefined;
      const t = name && this.tracks.get(name);
      if (t) t.samples.push(s);
    }
  }

  /** Recompute window states at nowNs (normally the latest frame time). */
  update(nowNs: bigint): GuidanceState {
    const e = this.cfg.engine;
    const views: RuleView[] = [];
    for (const [rule, t] of this.tracks) {
      const from = nowNs - this.windowNs;
      if (t.samples.length && t.samples[0]!.tNs <= from)
        t.samples = t.samples.filter((s) => s.tNs > from);
      const n = t.samples.length;
      const unknown = t.samples.filter((s) => s.state === 'UNKNOWN').length;
      const known = n - unknown;
      const bad = t.samples.filter((s) => s.state === 'FAIL' || s.state === 'WARN').length;
      const badFrac = known ? bad / known : 0;
      let next: WindowState;
      if (n < e.minSamples || unknown / n > e.unknownFrac) next = 'UNKNOWN';
      else if (t.state === 'OK') next = badFrac > e.warnEnterFrac ? 'WARN' : 'OK';
      else if (t.state === 'WARN') next = badFrac < e.warnExitFrac ? 'OK' : 'WARN';
      else next = badFrac < e.warnExitFrac ? 'OK' : 'WARN';
      if (next === 'OK' && t.state !== 'OK') t.okSince = nowNs;
      if (next !== 'OK') t.okSince = null;
      if (next === 'WARN' && t.state !== 'WARN') t.warnSince = nowNs;
      if (next !== 'WARN') t.warnSince = null;
      t.state = next;
      const failing = [...t.samples].reverse().find((s) => s.state === 'FAIL' && s.hint);
      t.hint = next === 'WARN' ? (failing?.hint ?? t.hint) : null;
      views.push({ rule, state: next, badFrac, hint: t.hint });
    }
    const all = [...this.tracks.values()];
    const allOk = all.length > 0 && all.every((t) => t.state === 'OK');
    const okFor = allOk
      ? all.reduce((m, t) => {
          const d = nowNs - t.okSince!;
          return d < m ? d : m;
        }, nowNs - all[0]!.okSince!)
      : 0n;
    const gateOpen = allOk && okFor >= this.holdNs;
    const gateProgress = gateOpen
      ? 1
      : allOk && this.holdNs > 0n
        ? Math.min(1, Number(okFor) / Number(this.holdNs))
        : 0;
    const gateJustOpened = gateOpen && !this.gateWasOpen;
    this.gateWasOpen = gateOpen;
    const warnRule = this.priority.find((r) => this.tracks.get(r)!.state === 'WARN');
    const prompt = warnRule
      ? { rule: warnRule, key: this.tracks.get(warnRule)!.hint ?? fallbackKey(warnRule) }
      : null;
    const tracking = !prompt && all.some((t) => t.state === 'UNKNOWN');
    return { rules: views, gateOpen, gateProgress, gateJustOpened, prompt, tracking };
  }

  /**
   * The prompt to speak now, or null: a prompt is spoken when it appears and then at most once
   * per promptCooldownS while it stays (per prompt key).
   */
  speech(state: GuidanceState, nowNs: bigint): PromptKey | null {
    const key = state.prompt?.key;
    if (!key) return null;
    const last = this.lastSpoken.get(key);
    const cooldown = BigInt(Math.round(this.cfg.guidance.promptCooldownS * 1000)) * MS;
    if (last !== undefined && nowNs - last < cooldown) return null;
    this.lastSpoken.set(key, nowNs);
    return key;
  }

  /**
   * Severity of each WARN rule during recording: CRITICAL when a critical rule has been failing
   * longer than its limit (subject missing, wrong hand, second person, shake), WARN otherwise.
   * UNKNOWN rules are INFO (never escalate on missing input).
   */
  severities(nowNs: bigint): { rule: RuleName; severity: Severity }[] {
    const c = this.cfg.critical;
    const limitS: Partial<Record<RuleName, number>> = {
      subject_present: c.subjectMissingS,
      required_landmarks_visible: c.subjectMissingS,
      handedness_match: c.wrongSideS,
      single_person: c.secondPersonS,
      shake: c.shakeS,
    };
    const out: { rule: RuleName; severity: Severity }[] = [];
    for (const [rule, t] of this.tracks) {
      if (t.state === 'UNKNOWN') out.push({ rule, severity: 'INFO' });
      else if (t.state === 'WARN') {
        const lim = limitS[rule];
        const forNs = t.warnSince === null ? 0n : nowNs - t.warnSince;
        const critical = lim !== undefined && forNs >= BigInt(Math.round(lim * 1000)) * MS;
        out.push({ rule, severity: critical ? 'CRITICAL' : 'WARN' });
      }
    }
    return out;
  }

  /** Forget all history (new framing, camera re-opened). */
  reset(): void {
    for (const t of this.tracks.values()) {
      t.samples = [];
      t.state = 'UNKNOWN';
      t.okSince = null;
      t.warnSince = null;
      t.hint = null;
    }
    this.gateWasOpen = false;
    this.lastSpoken.clear();
  }
}

/** Prompt used when a failing rule gave no hint. */
export function fallbackKey(rule: RuleName): PromptKey {
  const map: Record<RuleName, PromptKey> = {
    subject_present: 'no_subject',
    required_landmarks_visible: 'show_body',
    in_safe_zone: 'move_back',
    subject_size: 'move_back',
    handedness_match: 'wrong_hand',
    single_person: 'one_person',
    side_view: 'turn_side_on',
    face_frontal: 'face_camera',
    brightness: 'too_dark',
    face_light_balance: 'uneven_light',
    sharpness: 'blurry',
    tilt: 'level_phone',
    shake: 'hold_still',
    analysis_health: 'hold_still',
  };
  return map[rule];
}

/** Low recording fps for longer than lowFpsS (CRITICAL, §9.3). */
export function lowFpsCritical(
  fpsSamples: readonly { tNs: bigint; fps: number }[],
  cfg: QualityConfig['critical'],
): boolean {
  let since: bigint | null = null;
  const limit = BigInt(Math.round(cfg.lowFpsS * 1000)) * MS;
  for (const s of fpsSamples) {
    if (s.fps < cfg.minRecordingFps) {
      since ??= s.tNs;
      if (s.tNs - since >= limit) return true;
    } else since = null;
  }
  return false;
}
