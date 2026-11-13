import { describe, expect, it } from 'vitest';
import type { RecordingResult } from '@neurocapture/capture-kit';
import {
  cleanNote,
  completedTakes,
  lastTake,
  retakesLeft,
  stepTakes,
  summarizeOutcomes,
  validReason,
  type SessionInput,
} from '../src/session/machine.ts';
import { persist, startSession, type SessionActor } from '../src/session/persist.ts';

const input: SessionInput = {
  sessionId: 's1',
  operatorId: 'OP-07',
  plan: [
    { code: 'FT', side: 'R' },
    { code: 'FA', side: null },
  ],
  maxRetakes: 3,
  skipReasons: ['patient_unable', 'other'],
  overrideReasons: ['patient_fatigue', 'other'],
  consentVersion: 'CONSENT@1.0',
};
const at = '2026-11-13T10:00:00Z';
const patient = { localId: 'p1', ref: 'A0142', yearOfBirth: 1958, sex: 'M' as const };

function result(takeId: string): RecordingResult {
  return { takeId } as RecordingResult;
}

function state(a: SessionActor): string {
  return JSON.stringify(a.getSnapshot().value);
}

function started(): SessionActor {
  const a = startSession(input);
  a.send({ type: 'SET_PATIENT', patient });
  a.send({ type: 'SET_MED_STATE', medState: 'ON' });
  a.send({ type: 'SET_CONSENT', given: true, at });
  a.send({ type: 'START', at });
  return a;
}

function take(a: SessionActor, id: string, verdict: 'PASS' | 'RETAKE') {
  a.send({ type: 'RECORD', takeId: id });
  a.send({ type: 'COUNTDOWN_DONE' });
  a.send({ type: 'TAKE_FINISHED', result: result(id), verdict, reasons: [] });
}

describe('session machine', () => {
  it('needs patient, medication state and consent before starting', () => {
    const a = startSession(input);
    a.send({ type: 'START', at });
    expect(state(a)).toBe('"setup"');
    a.send({ type: 'SET_PATIENT', patient });
    a.send({ type: 'SET_MED_STATE', medState: 'OFF' });
    a.send({ type: 'SET_CONSENT', given: true, at });
    a.send({ type: 'SET_CONSENT', given: false, at }); // withdrawn
    a.send({ type: 'START', at });
    expect(state(a)).toBe('"setup"');
    a.send({ type: 'SET_CONSENT', given: true, at });
    a.send({ type: 'START', at });
    expect(state(a)).toBe('{"test":"intro"}');
    expect(a.getSnapshot().context.startedAt).toBe(at);
    expect(a.getSnapshot().context.consent).toEqual({ version: 'CONSENT@1.0', at });
  });

  it('runs a passing take through to the next test and the summary', () => {
    const a = started();
    a.send({ type: 'CONTINUE' });
    a.send({ type: 'BACK' });
    expect(state(a)).toBe('{"test":"intro"}');
    a.send({ type: 'CONTINUE' });
    take(a, 't1', 'PASS');
    expect(state(a)).toBe('{"test":"review"}');
    a.send({ type: 'KEEP' }); // not offered for a PASS
    expect(state(a)).toBe('{"test":"review"}');
    a.send({ type: 'ACCEPT' });
    expect(a.getSnapshot().context.index).toBe(1);
    expect(state(a)).toBe('{"test":"intro"}');
    a.send({ type: 'CONTINUE' });
    take(a, 't2', 'PASS');
    a.send({ type: 'ACCEPT' });
    expect(state(a)).toBe('"summary"');
    expect(summarizeOutcomes(a.getSnapshot().context)).toEqual({
      passed: 2,
      kept: 0,
      skipped: 0,
      pending: 0,
    });
    a.send({ type: 'FINISH', at });
    expect(a.getSnapshot().status).toBe('done');
    expect(a.getSnapshot().context.endedAt).toBe(at);
  });

  it('allows 3 retakes, then only keep (with a reason) or skip', () => {
    const a = started();
    a.send({ type: 'CONTINUE' });
    take(a, 't1', 'RETAKE');
    a.send({ type: 'ACCEPT' }); // not allowed for a RETAKE verdict
    expect(state(a)).toBe('{"test":"review"}');
    for (const id of ['t2', 't3', 't4']) {
      expect(retakesLeft(a.getSnapshot().context)).toBeGreaterThan(0);
      a.send({ type: 'RETAKE' });
      take(a, id, 'RETAKE');
    }
    expect(retakesLeft(a.getSnapshot().context)).toBe(0);
    a.send({ type: 'RETAKE' });
    expect(state(a)).toBe('{"test":"review"}');
    a.send({ type: 'KEEP' });
    expect(state(a)).toBe('{"test":"keep"}');
    a.send({ type: 'CANCEL' });
    a.send({ type: 'KEEP' });
    a.send({ type: 'CONFIRM_KEEP', reason: 'not_a_reason', at });
    a.send({ type: 'CONFIRM_KEEP', reason: 'other', note: '  ', at }); // other needs a note
    expect(state(a)).toBe('{"test":"keep"}');
    a.send({ type: 'CONFIRM_KEEP', reason: 'patient_fatigue', note: ' tired ', at });
    const ctx = a.getSnapshot().context;
    expect(ctx.outcomes[0]).toEqual({
      status: 'kept',
      takeId: 't4',
      reason: 'patient_fatigue',
      note: 'tired',
      operatorId: 'OP-07',
      at,
    });
    expect(completedTakes(ctx, 0)).toHaveLength(4);
  });

  it('skips from the intro or after a failed take, with a valid reason', () => {
    const a = started();
    a.send({ type: 'SKIP', reason: 'other', at });
    expect(state(a)).toBe('{"test":"intro"}');
    expect(a.getSnapshot().context.index).toBe(0);
    a.send({ type: 'SKIP', reason: 'patient_unable', at });
    expect(a.getSnapshot().context.outcomes[0]).toEqual({
      status: 'skipped',
      reason: 'patient_unable',
      note: null,
      at,
    });
    a.send({ type: 'CONTINUE' });
    take(a, 't1', 'RETAKE');
    a.send({ type: 'SKIP', reason: 'other', note: 'camera fell', at });
    expect(state(a)).toBe('"summary"');
    expect(summarizeOutcomes(a.getSnapshot().context)).toEqual({
      passed: 0,
      kept: 0,
      skipped: 2,
      pending: 0,
    });
  });

  it('cancels a countdown and records a failed take as interrupted', () => {
    const a = started();
    a.send({ type: 'CONTINUE' });
    a.send({ type: 'RECORD', takeId: 'c1' });
    a.send({ type: 'CANCEL' });
    expect(state(a)).toBe('{"test":"framing"}');
    expect(a.getSnapshot().context.currentTakeId).toBeNull();
    a.send({ type: 'RECORD', takeId: 'f1' });
    a.send({ type: 'COUNTDOWN_DONE' });
    a.send({ type: 'TAKE_FAILED' });
    const ctx = a.getSnapshot().context;
    expect(state(a)).toBe('{"test":"framing"}');
    expect(ctx.notice).toBe('take_interrupted');
    expect(lastTake(ctx)).toMatchObject({ takeId: 'f1', verdict: 'INTERRUPTED', takeNo: 1 });
    expect(completedTakes(ctx)).toHaveLength(0);
    a.send({ type: 'RECORD', takeId: 'f2' }); // a new take clears the notice
    expect(a.getSnapshot().context.notice).toBeNull();
  });

  it('restores after process death: recording → interrupted, countdown → framing', () => {
    const a = started();
    a.send({ type: 'CONTINUE' });
    a.send({ type: 'RECORD', takeId: 'r1' });
    a.send({ type: 'COUNTDOWN_DONE' });
    const saved = JSON.parse(JSON.stringify(persist(a)));
    const b = startSession(input, saved);
    expect(state(b)).toBe('{"test":"framing"}');
    expect(lastTake(b.getSnapshot().context)).toMatchObject({
      takeId: 'r1',
      verdict: 'INTERRUPTED',
    });
    expect(b.getSnapshot().context.notice).toBe('take_interrupted');

    b.send({ type: 'RECORD', takeId: 'r2' });
    const c = startSession(input, JSON.parse(JSON.stringify(persist(b))));
    expect(state(c)).toBe('{"test":"framing"}');
    expect(c.getSnapshot().context.takes[0]).toHaveLength(1); // countdown never started a recording

    // Restoring in a stable state changes nothing.
    c.send({ type: 'BACK' });
    const d = startSession(input, JSON.parse(JSON.stringify(persist(c))));
    expect(state(d)).toBe('{"test":"intro"}');
    expect(d.getSnapshot().context.patient).toEqual(patient);
  });

  it('cleans notes and validates reasons', () => {
    expect(cleanNote(undefined)).toBeNull();
    expect(cleanNote('  ')).toBeNull();
    expect(cleanNote(' x ')).toBe('x');
    expect(validReason(['a', 'other'], 'a', undefined)).toBe(true);
    expect(validReason(['a', 'other'], 'other', 'why')).toBe(true);
    expect(validReason(['a', 'other'], 'other', undefined)).toBe(false);
    expect(validReason(['a'], 'b', 'x')).toBe(false);
  });

  it('reports no last take and full retakes before recording', () => {
    const a = started();
    const ctx = a.getSnapshot().context;
    expect(summarizeOutcomes(ctx)).toEqual({ passed: 0, kept: 0, skipped: 0, pending: 2 });
    expect(stepTakes(ctx, 9)).toEqual([]);
    expect(lastTake(ctx)).toBeNull();
    expect(retakesLeft(ctx)).toBe(3);
    expect(completedTakes(ctx, 5)).toEqual([]);
  });
});
