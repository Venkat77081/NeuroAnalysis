/**
 * Biomarker readiness (DEV_PLAN §10, M8): for every registered biomarker of a test, can this take
 * feed it? COMPUTABLE / PARTIAL / NOT_COMPUTABLE with a reason, which inputs are missing, and
 * whether a retake could fix it. The device stores this as a hint; the server recomputes it and is
 * authoritative. Readiness is never shown to operators: retake-fixable failures become plain
 * RETAKE reasons (readinessRetakeReasons), never biomarker names.
 */
import type { BiomarkerRegistry } from '@neurocapture/contracts-ts';
import type { Window } from '../detectors/signal.ts';
import type { LandmarkFrame, TrackerName } from '../types.ts';
import type { VerdictReason } from './capture.ts';

export type ReadinessStatus = 'COMPUTABLE' | 'PARTIAL' | 'NOT_COMPUTABLE';
export type MissingInput = 'fps' | 'duration' | 'tracker' | 'landmarks' | 'phases' | 'sensors';

export interface ReadinessItem {
  status: ReadinessStatus;
  reason?: string;
  retakeFixable?: boolean;
  missing?: MissingInput[];
}

export interface ReadinessHint {
  registryVersion: string;
  items: Record<string, ReadinessItem>;
}

export interface ReadinessEvidence {
  effectiveFps: number;
  durationS: number;
  /** Trackers recorded in this take. */
  trackers: readonly TrackerName[];
  frames: readonly LandmarkFrame[];
  /** Canonical time of video sample 0; frame times are measured from it. */
  startNs: bigint;
  /** Movement window (video seconds); visibility is measured inside it, else over the whole take. */
  movementWindow: Window | null;
  /** Detector phase/event kinds seen (SAW: stand_up, walk_out, turn, walk_back, …). */
  phases: readonly string[];
  sensors: boolean;
  /** Both hands required by the test (DNE protocol). */
  handsNeeded: number;
  poseMinVisibility: number;
  handMinScore: number;
}

/** Which inputs a retake can fix (camera placement, patient in view, full duration, task done). */
export const RETAKE_FIXABLE: readonly MissingInput[] = ['fps', 'duration', 'landmarks', 'phases'];

/** Quality rules whose evidence explains a missing input (server report, §10 mapping). */
export const QUALITY_RULES_FOR: Record<MissingInput, readonly string[]> = {
  fps: ['frame_drops', 'analysis_health'],
  duration: ['duration'],
  tracker: [],
  landmarks: ['required_landmarks_visible', 'in_safe_zone', 'subject_present'],
  phases: ['saw_phases'],
  sensors: ['tilt', 'shake'],
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Fraction of frames (inside the window) where every listed landmark is visible. */
export function landmarkVisibleFrac(
  frames: readonly LandmarkFrame[],
  landmarks: Partial<Record<TrackerName, readonly number[]>>,
  ev: Pick<
    ReadinessEvidence,
    'startNs' | 'movementWindow' | 'handsNeeded' | 'poseMinVisibility' | 'handMinScore'
  >,
): number {
  const w = ev.movementWindow;
  const inWindow = frames.filter((f) => {
    if (!w) return true;
    const t = Number(f.tNs - ev.startNs) / 1e9;
    return t >= w.tStartS && t <= w.tEndS;
  });
  if (!inWindow.length) return 0;
  const inImage = (p: { x: number; y: number } | undefined) =>
    !!p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  let ok = 0;
  for (const f of inWindow) {
    let visible = true;
    if (landmarks.pose?.length)
      visible &&= landmarks.pose.every((i) => {
        const p = f.pose?.[i];
        return !!p && (p.v ?? 0) >= ev.poseMinVisibility && inImage(p);
      });
    if (landmarks.hand?.length) {
      const good = f.hands.filter(
        (h) => h.score >= ev.handMinScore && landmarks.hand!.every((i) => inImage(h.pts[i])),
      ).length;
      visible &&= good >= ev.handsNeeded;
    }
    if (landmarks.face?.length)
      visible &&= !!f.face && landmarks.face.every((i) => inImage(f.face!.pts[i]));
    if (visible) ok++;
  }
  return ok / inWindow.length;
}

const WORSE: Record<ReadinessStatus, number> = { COMPUTABLE: 0, PARTIAL: 1, NOT_COMPUTABLE: 2 };

/** Readiness of every registered biomarker of `testCode` for this take. */
export function readinessHint(
  registry: BiomarkerRegistry,
  testCode: string,
  ev: ReadinessEvidence,
): ReadinessHint {
  const items: Record<string, ReadinessItem> = {};
  const visCache = new Map<string, number>();
  for (const b of registry.biomarkers.filter((x) => x.testCode === testCode)) {
    const inp = b.inputs;
    let status: ReadinessStatus = 'COMPUTABLE';
    const reasons: string[] = [];
    const missing: MissingInput[] = [];
    const fail = (s: ReadinessStatus, m: MissingInput, reason: string) => {
      if (WORSE[s] > WORSE[status]) status = s;
      missing.push(m);
      reasons.push(reason);
    };
    if (inp.minEffectiveFps !== undefined && ev.effectiveFps < inp.minEffectiveFps)
      fail(
        'NOT_COMPUTABLE',
        'fps',
        `requires >= ${inp.minEffectiveFps} fps; effective ${r1(ev.effectiveFps)} fps`,
      );
    if (inp.minDurationS !== undefined && ev.durationS < inp.minDurationS)
      fail(
        'NOT_COMPUTABLE',
        'duration',
        `requires >= ${inp.minDurationS} s; recorded ${r1(ev.durationS)} s`,
      );
    const absent = (inp.trackers ?? []).filter((t) => !ev.trackers.includes(t));
    if (absent.length) fail('NOT_COMPUTABLE', 'tracker', `not recorded: ${absent.join(', ')}`);
    else if (inp.landmarks && Object.keys(inp.landmarks).length) {
      const key = JSON.stringify(inp.landmarks);
      let frac = visCache.get(key);
      if (frac === undefined) {
        frac = landmarkVisibleFrac(ev.frames, inp.landmarks, ev);
        visCache.set(key, frac);
      }
      const min = inp.minLandmarkVisibleFrac ?? 0.9;
      if (frac < min)
        fail(
          frac >= min / 2 ? 'PARTIAL' : 'NOT_COMPUTABLE',
          'landmarks',
          `required landmarks visible in ${r1(frac * 100)}% of frames; needs ${r1(min * 100)}%`,
        );
    }
    const phasesMissing = (inp.requiresPhases ?? []).filter((p) => !ev.phases.includes(p));
    if (phasesMissing.length)
      fail('NOT_COMPUTABLE', 'phases', `phases not detected: ${phasesMissing.join(', ')}`);
    if (inp.requiresSensors && !ev.sensors) fail('NOT_COMPUTABLE', 'sensors', 'no sensor data');
    items[b.id] =
      status === 'COMPUTABLE'
        ? { status }
        : {
            status,
            reason: reasons.join('; '),
            retakeFixable: missing.every((m) => RETAKE_FIXABLE.includes(m)),
            missing,
          };
  }
  return { registryVersion: registry.registryVersion, items };
}

/**
 * Plain RETAKE reasons for readiness failures a retake can fix (§9.5, §10), skipping causes the
 * verdict already names. Frame rate is left to the verdict's own limit: a doctor may lower it
 * (decision 015), and readiness must not override that choice; the hint still records it.
 */
export function readinessRetakeReasons(
  hint: ReadinessHint,
  existing: readonly VerdictReason[],
): VerdictReason[] {
  const have = new Set(existing.map((r) => r.code));
  const failing = Object.values(hint.items).filter(
    (i) => i.status === 'NOT_COMPUTABLE' && i.retakeFixable,
  );
  const missing = new Set(failing.flatMap((i) => i.missing ?? []));
  const out: VerdictReason[] = [];
  if (missing.has('duration') && !have.has('duration_short') && !have.has('stopped_early'))
    out.push({ code: 'duration_short', messageKey: 'verdict.duration_short' });
  if (missing.has('landmarks') && !have.has('landmarks_low') && !have.has('key_points_hidden'))
    out.push({ code: 'key_points_hidden', messageKey: 'verdict.key_points_hidden' });
  if (missing.has('phases') && !have.has('protocol_incomplete'))
    out.push({ code: 'protocol_incomplete', messageKey: 'verdict.protocol_incomplete' });
  return out;
}
