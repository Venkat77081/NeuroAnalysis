import { describe, expect, it } from 'vitest';
import { MockCaptureKit, sampleFixtures } from '@neurocapture/capture-kit';
import { browserStore, kitStore, memoryStorage } from '../src/data/store.ts';
import { maskRef, newId, repo } from '../src/data/repo.ts';

const patient = { localId: 'p-1', ref: 'A0142', yearOfBirth: 1958, sex: 'M' as const };

describe.each([
  ['browser (dev)', () => browserStore(memoryStorage())],
  ['kit (device)', () => kitStore(new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] }))],
])('%s store', (_name, make) => {
  it('stores patients, the session snapshot and settings', async () => {
    const r = repo(make());
    expect(await r.listPatients()).toEqual([]);
    await r.savePatient(patient);
    await r.savePatient({ ...patient, localId: 'p-0', ref: '0001' });
    expect((await r.listPatients()).map((p) => p.ref)).toEqual(['0001', 'A0142']);
    expect(await r.loadSession()).toBeNull();
    await r.saveSession({ value: 'setup' });
    expect(await r.loadSession()).toEqual({ value: 'setup' });
    await r.clearSession();
    expect(await r.loadSession()).toBeNull();
    expect(await r.settings()).toEqual({ operatorId: 'OP-LOCAL', language: 'en' });
    await r.saveSettings({ operatorId: 'OP-07', language: 'hi' });
    expect(await r.settings()).toEqual({ operatorId: 'OP-07', language: 'hi' });
    await r.archiveSession('S-AB', { passed: 7 });
    expect(await r.store.keys('sessiondone.')).toEqual(['sessiondone.s-ab']);
  });
});

describe('helpers', () => {
  it('masks references and makes random ids', () => {
    expect(maskRef('A0142')).toBe('••••0142');
    expect(maskRef('12')).toBe('12');
    expect(newId('s')).toMatch(/^s-[0-9a-f]{16}$/);
    expect(newId('s')).not.toBe(newId('s'));
  });

  it('marks only the device store as encrypted', () => {
    expect(browserStore(memoryStorage()).encrypted).toBe(false);
    expect(kitStore(new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] })).encrypted).toBe(
      true,
    );
  });

  it('memory storage behaves like Storage', () => {
    const s = memoryStorage();
    s.setItem('a', '1');
    expect(s.length).toBe(1);
    expect(s.key(0)).toBe('a');
    expect(s.key(5)).toBeNull();
    s.clear();
    expect(s.getItem('a')).toBeNull();
  });
});
