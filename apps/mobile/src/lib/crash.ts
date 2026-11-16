/**
 * PII-safe crash reports from the web layer (M9). Uncaught errors and unhandled promise
 * rejections become a small redacted report (error name, message, top stack frames with file
 * names only, the session screen) queued in CaptureKit for POST /diagnostics. Native crashes are
 * reported by the plugin itself.
 */
import { PLUGIN_VERSION, type CaptureKitPlugin } from '@neurocapture/capture-kit';
import { APP_VERSION } from './evidence.ts';
import { logger, redactString } from './logger.ts';

/** Keep only "function (file:line)" from a stack line: no URLs, folders or query strings. */
function frame(line: string): string {
  return redactString(
    line
      .trim()
      .replace(/(?:https?|capacitor|file):\/\/[^\s)]*\/([^/\s)?#]+)(?:\?[^\s):]*)?/g, '$1')
      .slice(0, 200),
  );
}

export function crashReport(
  error: unknown,
  ctx: { screen: string | null; platform: string; at: string },
): { kind: 'crash'; report: Record<string, unknown> } {
  const e =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'non-error thrown');
  return {
    kind: 'crash',
    report: {
      source: 'js',
      at: ctx.at,
      app_version: APP_VERSION,
      plugin_version: PLUGIN_VERSION,
      platform: ctx.platform.slice(0, 40),
      error: (e.name || 'Error').slice(0, 100),
      message: redactString(e.message ?? '').slice(0, 500),
      stack: (e.stack ?? '').split('\n').slice(1, 31).map(frame).filter(Boolean),
      screen: ctx.screen?.slice(0, 60) ?? null,
    },
  };
}

/** Install once at start-up. `screen` names the current session state (no patient data). */
export function installCrashReporter(
  kit: Pick<CaptureKitPlugin, 'enqueueDiagnostic'>,
  screen: () => string | null,
  target: Pick<Window, 'addEventListener'> = globalThis as unknown as Window,
): void {
  let sent = 0;
  const report = (error: unknown) => {
    if (sent >= 5) return; // a crash loop must not flood the queue
    sent++;
    const body = crashReport(error, {
      screen: screen(),
      platform: globalThis.navigator?.userAgent?.includes('Android') ? 'android webview' : 'web',
      at: new Date().toISOString(),
    });
    logger.error('crash', { error: body.report.error });
    kit.enqueueDiagnostic({ body: JSON.stringify(body) }).catch(() => undefined);
  };
  target.addEventListener('error', (ev) =>
    report((ev as ErrorEvent).error ?? (ev as ErrorEvent).message),
  );
  target.addEventListener('unhandledrejection', (ev) =>
    report((ev as PromiseRejectionEvent).reason),
  );
}

/** Set by the app shell: the current session state, e.g. {"test":"review"}. */
export const crashScreen: { get: () => string | null } = { get: () => null };
