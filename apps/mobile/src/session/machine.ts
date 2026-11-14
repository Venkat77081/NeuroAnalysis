/**
 * Session state machine (DEV_PLAN §5.4). Pure: no camera, storage or clock access — timestamps and
 * take results arrive in events, so the machine is deterministic and fully testable in Node.
 * Persisted after every transition (see persist.ts); a take in progress when the app died becomes
 * Interrupted on restore.
 */
import { assign, setup } from 'xstate';
import type { RecordingResult } from '@neurocapture/capture-kit';
import type { VerdictReason } from '@neurocapture/quality-core';

export type TestCode = 'FT' | 'FTF' | 'FR' | 'SAW' | 'FA';
export type Side = 'R' | 'L' | null;
export type MedState = 'ON' | 'OFF' | 'NA';

export interface PlanStep {
  code: TestCode;
  side: Side;
}

/** Local only (encrypted on the device). Never sent to the server as-is (§14). */
export interface Patient {
  localId: string;
  ref: string;
  yearOfBirth: number | null;
  sex: 'M' | 'F' | 'O' | null;
}

/** What the Review timeline shows for a take (M6): seconds from video start. */
export interface TakeTimeline {
  durationS: number;
  movementWindow: { tStartS: number; tEndS: number } | null;
  alerts: { tStartS: number; tEndS: number; severity: 'WARN' | 'CRITICAL' }[];
  /** Detected movement events (taps, rolls, touches, phases, expressions). */
  marks: number[];
  counts: Record<string, number>;
}

export interface TakeRecord {
  takeId: string;
  takeNo: number;
  verdict: 'PASS' | 'RETAKE' | 'INTERRUPTED';
  reasons: VerdictReason[];
  result: RecordingResult | null;
  timeline?: TakeTimeline;
}

export type StepOutcome =
  | { status: 'pending' }
  | { status: 'accepted'; takeId: string }
  | {
      status: 'kept';
      takeId: string;
      reason: string;
      note: string | null;
      operatorId: string;
      at: string;
    }
  | { status: 'skipped'; reason: string; note: string | null; at: string };

export interface SessionInput {
  sessionId: string;
  operatorId: string;
  plan: PlanStep[];
  maxRetakes: number;
  skipReasons: string[];
  overrideReasons: string[];
  /** Reasons for ending a session before all tests are done (config `abortReasons`). */
  abortReasons: string[];
  consentVersion: string;
}

export interface SessionContext extends SessionInput {
  patient: Patient | null;
  medState: MedState | null;
  consent: { version: string; at: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  index: number;
  takes: TakeRecord[][];
  outcomes: StepOutcome[];
  currentTakeId: string | null;
  notice: 'take_interrupted' | null;
  /** Set when the operator ended the session early; remaining tests stay "Not done". */
  aborted: { reason: string; note: string | null; at: string } | null;
}

export type SessionEvent =
  | { type: 'SET_PATIENT'; patient: Patient }
  | { type: 'SET_MED_STATE'; medState: MedState }
  | { type: 'SET_CONSENT'; given: boolean; at: string }
  | { type: 'START'; at: string }
  | { type: 'CONTINUE' }
  | { type: 'BACK' }
  | { type: 'RECORD'; takeId: string }
  | { type: 'COUNTDOWN_DONE' }
  | { type: 'CANCEL' }
  | {
      type: 'TAKE_FINISHED';
      result: RecordingResult;
      verdict: 'PASS' | 'RETAKE';
      reasons: VerdictReason[];
      timeline?: TakeTimeline;
    }
  | { type: 'TAKE_FAILED' }
  | { type: 'ACCEPT' }
  | { type: 'RETAKE' }
  | { type: 'KEEP' }
  | { type: 'CONFIRM_KEEP'; reason: string; note?: string; at: string }
  | { type: 'SKIP'; reason: string; note?: string; at: string }
  | { type: 'RESTORED' }
  | { type: 'ABORT'; reason: string; note?: string; at: string }
  | { type: 'PREV_STEP' }
  | { type: 'NEXT_STEP' }
  | { type: 'FINISH'; at: string };

/** All takes of a step (empty for an index outside the plan). */
export function stepTakes(ctx: SessionContext, index = ctx.index): TakeRecord[] {
  return ctx.takes[index] ?? [];
}

/** Completed takes (interrupted ones do not use up retakes). */
export function completedTakes(ctx: SessionContext, index = ctx.index): TakeRecord[] {
  return stepTakes(ctx, index).filter((t) => t.verdict !== 'INTERRUPTED');
}

export function lastTake(ctx: SessionContext): TakeRecord | null {
  return stepTakes(ctx).at(-1) ?? null;
}

/** Trimmed free text, or null when empty. */
export function cleanNote(note: string | undefined): string | null {
  return note?.trim() || null;
}

/** Retakes still allowed for the current step (maxRetakes after the first take). */
export function retakesLeft(ctx: SessionContext): number {
  const used = Math.max(0, completedTakes(ctx).length - 1);
  return Math.max(0, ctx.maxRetakes - used);
}

/** Reasons come from the session config; "other" needs a note (DEV_PLAN §5.4). */
export function validReason(allowed: string[], reason: string, note: string | undefined): boolean {
  return allowed.includes(reason) && (reason !== 'other' || cleanNote(note) !== null);
}

function withTake(ctx: SessionContext, take: Omit<TakeRecord, 'takeNo'>): TakeRecord[][] {
  const takes = ctx.takes.map((t) => [...t]);
  takes[ctx.index] = [...stepTakes(ctx), { ...take, takeNo: stepTakes(ctx).length + 1 }];
  return takes;
}

function withOutcome(ctx: SessionContext, outcome: StepOutcome): StepOutcome[] {
  const outcomes = [...ctx.outcomes];
  outcomes[ctx.index] = outcome;
  return outcomes;
}

/** Only reachable from recording, where RECORD always set currentTakeId. */
function interrupted(ctx: SessionContext): TakeRecord[][] {
  return withTake(ctx, {
    takeId: ctx.currentTakeId!,
    verdict: 'INTERRUPTED',
    reasons: [],
    result: null,
  });
}

type Ev<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

export const sessionMachine = setup({
  types: {
    context: {} as SessionContext,
    events: {} as SessionEvent,
    input: {} as SessionInput,
  },
  guards: {
    readyToStart: ({ context }) => !!context.patient && !!context.medState && !!context.consent,
    lastVerdictPass: ({ context }) => lastTake(context)?.verdict === 'PASS',
    lastVerdictRetake: ({ context }) => lastTake(context)?.verdict === 'RETAKE',
    canRetake: ({ context }) => retakesLeft(context) > 0,
    validKeep: ({ context, event }) => {
      const e = event as Ev<'CONFIRM_KEEP'>;
      return validReason(context.overrideReasons, e.reason, e.note);
    },
    validSkip: ({ context, event }) => {
      const e = event as Ev<'SKIP'>;
      return validReason(context.skipReasons, e.reason, e.note);
    },
    atEnd: ({ context }) => context.index >= context.plan.length,
    validAbort: ({ context, event }) => {
      const e = event as Ev<'ABORT'>;
      return validReason(context.abortReasons ?? [], e.reason, e.note); // ?? : snapshots from before abort existed
    },
    hasPrev: ({ context }) => context.index > 0,
    stepDone: ({ context }) => context.outcomes[context.index]?.status !== 'pending',
  },
  actions: {
    advance: assign({
      index: ({ context }) => context.index + 1,
      notice: null,
      currentTakeId: null,
    }),
  },
}).createMachine({
  id: 'session',
  context: ({ input }) => ({
    ...input,
    patient: null,
    medState: null,
    consent: null,
    startedAt: null,
    endedAt: null,
    index: 0,
    takes: input.plan.map(() => []),
    outcomes: input.plan.map(() => ({ status: 'pending' }) as StepOutcome),
    currentTakeId: null,
    notice: null,
    aborted: null,
  }),
  initial: 'setup',
  states: {
    setup: {
      on: {
        SET_PATIENT: { actions: assign({ patient: ({ event }) => event.patient }) },
        SET_MED_STATE: { actions: assign({ medState: ({ event }) => event.medState }) },
        SET_CONSENT: {
          actions: assign({
            consent: ({ context, event }) =>
              event.given ? { version: context.consentVersion, at: event.at } : null,
          }),
        },
        START: {
          guard: 'readyToStart',
          target: 'test',
          actions: assign({ startedAt: ({ event }) => event.at }),
        },
      },
    },
    test: {
      initial: 'intro',
      on: {
        // Allowed between takes only: countdown and recording do not handle ABORT.
        ABORT: {
          guard: 'validAbort',
          target: '#session.summary',
          actions: assign({
            aborted: ({ event }) => ({
              reason: event.reason,
              note: cleanNote(event.note),
              at: event.at,
            }),
            currentTakeId: null,
            notice: null,
          }),
        },
      },
      states: {
        intro: {
          on: {
            CONTINUE: 'framing',
            // Back to an earlier test; its result stays until a new take replaces it.
            PREV_STEP: {
              guard: 'hasPrev',
              target: 'intro',
              reenter: true,
              actions: assign({ index: ({ context }) => context.index - 1, notice: null }),
            },
            // After going back: keep that test's result and move on without a new take.
            NEXT_STEP: { guard: 'stepDone', target: 'next' },
            SKIP: {
              guard: 'validSkip',
              target: 'next',
              actions: assign({
                outcomes: ({ context, event }) =>
                  withOutcome(context, {
                    status: 'skipped',
                    reason: event.reason,
                    note: cleanNote(event.note),
                    at: event.at,
                  }),
              }),
            },
          },
        },
        framing: {
          on: {
            BACK: 'intro',
            RECORD: {
              target: 'countdown',
              actions: assign({ currentTakeId: ({ event }) => event.takeId, notice: null }),
            },
          },
        },
        countdown: {
          on: {
            COUNTDOWN_DONE: 'recording',
            ABORT: {},
            CANCEL: { target: 'framing', actions: assign({ currentTakeId: null }) },
            RESTORED: { target: 'framing', actions: assign({ currentTakeId: null }) },
          },
        },
        recording: {
          on: {
            ABORT: {},
            TAKE_FINISHED: {
              target: 'review',
              actions: assign({
                takes: ({ context, event }) =>
                  withTake(context, {
                    takeId: event.result.takeId,
                    verdict: event.verdict,
                    reasons: event.reasons,
                    result: event.result,
                    ...(event.timeline ? { timeline: event.timeline } : {}),
                  }),
                currentTakeId: null,
              }),
            },
            TAKE_FAILED: {
              target: 'framing',
              actions: assign({
                takes: ({ context }) => interrupted(context),
                currentTakeId: null,
                notice: 'take_interrupted',
              }),
            },
            RESTORED: {
              target: 'framing',
              actions: assign({
                takes: ({ context }) => interrupted(context),
                currentTakeId: null,
                notice: 'take_interrupted',
              }),
            },
          },
        },
        review: {
          on: {
            ACCEPT: {
              guard: 'lastVerdictPass',
              target: 'next',
              actions: assign({
                outcomes: ({ context }) =>
                  withOutcome(context, { status: 'accepted', takeId: lastTake(context)!.takeId }),
              }),
            },
            RETAKE: { guard: 'canRetake', target: 'framing' },
            KEEP: { guard: 'lastVerdictRetake', target: 'keep' },
            SKIP: {
              guard: 'validSkip',
              target: 'next',
              actions: assign({
                outcomes: ({ context, event }) =>
                  withOutcome(context, {
                    status: 'skipped',
                    reason: event.reason,
                    note: cleanNote(event.note),
                    at: event.at,
                  }),
              }),
            },
          },
        },
        keep: {
          on: {
            CANCEL: 'review',
            CONFIRM_KEEP: {
              guard: 'validKeep',
              target: 'next',
              actions: assign({
                outcomes: ({ context, event }) =>
                  withOutcome(context, {
                    status: 'kept',
                    takeId: lastTake(context)!.takeId,
                    reason: event.reason,
                    note: cleanNote(event.note),
                    operatorId: context.operatorId,
                    at: event.at,
                  }),
              }),
            },
          },
        },
        next: {
          entry: 'advance',
          always: [{ guard: 'atEnd', target: '#session.summary' }, { target: 'intro' }],
        },
      },
    },
    summary: {
      on: { FINISH: { target: 'done', actions: assign({ endedAt: ({ event }) => event.at }) } },
    },
    done: { type: 'final' },
  },
});

/** Summary counts for the Summary screen. */
export function summarizeOutcomes(ctx: SessionContext): {
  passed: number;
  kept: number;
  skipped: number;
  pending: number;
} {
  const c = { passed: 0, kept: 0, skipped: 0, pending: 0 };
  for (const o of ctx.outcomes) {
    if (o.status === 'accepted') c.passed++;
    else if (o.status === 'kept') c.kept++;
    else if (o.status === 'skipped') c.skipped++;
    else c.pending++;
  }
  return c;
}
