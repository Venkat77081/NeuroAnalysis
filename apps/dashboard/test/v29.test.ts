import { describe, expect, it } from 'vitest';
import { barStates } from '../src/health.tsx';
import { notesFrom, unseen } from '../src/bell.tsx';
import { undoWindowMs } from '../src/undo.tsx';
import { appointmentChanges, deviceQrPrefix } from '../src/config.ts';
import type { Item } from '../src/overview.tsx';

const hours = (pings: number[], from = Date.parse('2026-11-18T12:00:00Z')) =>
  pings.map((p, i) => ({ start: new Date(from + i * 3_600_000).toISOString(), pings: p }));

describe('v29 connector strip', () => {
  it('greys hours before the connector was first seen, then marks missed hours red', () => {
    const h = {
      hours: hours([0, 0, 3, 4, 0, 2]),
      online: true,
      last_seen_at: '2026-11-18T17:10:00Z',
    };
    expect(barStates(h)).toEqual(['before', 'before', 'ok', 'ok', 'missed', 'ok']);
  });
  it('does not mark the hour that has only just started while online', () => {
    const h = { hours: hours([4, 4, 0]), online: true, last_seen_at: '2026-11-18T13:59:00Z' };
    expect(barStates(h)).toEqual(['ok', 'ok', 'ok']);
    expect(barStates({ ...h, online: false })).toEqual(['ok', 'ok', 'missed']);
  });
  it('marks every hour missed when the last check-in was before the window', () => {
    const h = { hours: hours([0, 0]), online: false, last_seen_at: '2026-11-17T08:40:00Z' };
    expect(barStates(h)).toEqual(['missed', 'missed']);
    expect(barStates({ ...h, last_seen_at: null })).toEqual(['before', 'before']);
  });
});

describe('v29 bell', () => {
  const item = (key: string, status: string, id: string): Item => ({
    key,
    status,
    id,
    name: null,
    ncid: null,
    at: null,
    doctor: null,
    place: null,
    flagged: null,
  });
  it('keeps only items with something to do, keyed by kind, id and state', () => {
    const notes = notesFrom(
      [item('hospital', 'connector_failing', 'h1'), item('hospital', 'ok', 'h2')],
      (i) => ({
        text: i.id!,
        action: i.status === 'ok' ? null : { label: 'Open', page: 'hospitals' },
      }),
    );
    expect(notes).toEqual([
      {
        key: 'hospital:h1:connector_failing',
        text: 'h1',
        tone: 'bad',
        label: 'Open',
        page: 'hospitals',
        ncid: undefined,
      },
    ]);
  });
  it('shows the dot only for keys not seen on this computer', () => {
    expect(unseen([{ key: 'a' }, { key: 'b' }], new Set(['a']))).toEqual(['b']);
    expect(unseen([{ key: 'a' }], new Set(['a']))).toEqual([]);
  });
});

describe('v29 config', () => {
  it('undo window and registration QR prefix come from config/platform.json', () => {
    expect(undoWindowMs()).toBe(appointmentChanges.undoSeconds * 1000);
    expect(deviceQrPrefix).toMatch(/^[a-z0-9]+:$/);
  });
});
