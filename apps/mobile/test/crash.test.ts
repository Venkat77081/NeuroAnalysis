import { describe, expect, it } from 'vitest';
import { crashReport, installCrashReporter } from '../src/lib/crash.ts';

describe('PII-safe crash reports (M9)', () => {
  it('keeps the error type and file:line frames, drops URLs, IDs and e-mails', () => {
    const e = new TypeError('no take 12345678 for a.b@c.org');
    e.stack = [
      'TypeError: no take',
      '    at finish (https://localhost/assets/CameraStage-abc123.js?v=2:210:15)',
      '    at capacitor://localhost/_capacitor_file_/data/user/0/app/files/takes/tk-9/video.mp4',
    ].join('\n');
    const r = crashReport(e, {
      screen: '{"test":"review"}',
      platform: 'android webview',
      at: '2026-11-14T10:00:00Z',
    }).report;
    expect(r).toMatchObject({
      source: 'js',
      error: 'TypeError',
      message: 'no take [number] for [email]',
      screen: '{"test":"review"}',
    });
    expect(r.stack).toEqual(['at finish (CameraStage-abc123.js:210:15)', 'at video.mp4']);
    expect(JSON.stringify(r)).not.toMatch(/data\/user|takes\/tk|https?:/);
    expect(crashReport('boom', { screen: null, platform: 'web', at: 'x' }).report.message).toBe(
      'boom',
    );
  });

  it('queues reports from uncaught errors and rejections, at most 5', () => {
    const handlers: Record<string, (ev: unknown) => void> = {};
    const sent: string[] = [];
    installCrashReporter(
      { enqueueDiagnostic: async ({ body }) => void sent.push(body) },
      () => 'setup',
      {
        addEventListener: (type: string, h: (ev: unknown) => void) => (handlers[type] = h),
      } as unknown as Window,
    );
    handlers.error!({ error: new RangeError('bad') });
    handlers.unhandledrejection!({ reason: new Error('lost') });
    for (let i = 0; i < 10; i++) handlers.error!({ message: 'loop' });
    expect(sent).toHaveLength(5);
    expect(JSON.parse(sent[0]!).report).toMatchObject({ error: 'RangeError', screen: 'setup' });
  });
});
