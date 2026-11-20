import { describe, expect, it } from 'vitest';
import { sessionReports } from '../src/biomarkers.tsx';

const recs = [
  { take_id: 'fr1', session_id: 's1', test_code: 'FR' },
  { take_id: 'ft1', session_id: 's1', test_code: 'FT' },
  { take_id: 'ftf1', session_id: 's1', test_code: 'FTF' },
  { take_id: 'ft0', session_id: 's0', test_code: 'FT' },
];

describe('v34: reports from the same visit', () => {
  it('lists the finished reports of the visit, in protocol order', () => {
    const runs = {
      fr1: { status: 'done' as const },
      ft1: { status: 'done' as const },
      ftf1: { status: 'running' as const },
      ft0: { status: 'done' as const },
    };
    expect(sessionReports(recs, runs, 'fr1')).toEqual([
      { take: 'ft1', test: 'FT' },
      { take: 'fr1', test: 'FR' },
    ]);
    expect(sessionReports(recs, runs, 'ft0')).toEqual([{ take: 'ft0', test: 'FT' }]);
  });

  it('keeps the asked take when the visit is unknown', () => {
    expect(sessionReports([], {}, 'x')).toEqual([{ take: 'x', test: '' }]);
  });
});
