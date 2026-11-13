/**
 * PII-safe logger (DEV_PLAN §3, §14). Never log patient names, external IDs, raw frames,
 * landmark streams or file paths containing IDs. Known-sensitive keys are dropped, and
 * long base64/ID-like strings are masked, before anything reaches the sink.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Sink = (level: Level, msg: string, fields: Record<string, unknown>) => void;

const SENSITIVE_KEYS = new Set([
  'name', 'patientname', 'firstname', 'lastname', 'externalref', 'externalid', 'patientref', 'phone', 'email',
  'address', 'dob', 'dateofbirth', 'lm', 'landmarks', 'frame', 'frames', 'image', 'pixels', 'blendshapes',
  'token', 'password', 'path', 'filepath', 'uri', 'url',
]);
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const LONG_DIGITS = /\b\d{6,}\b/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

export function redactString(s: string): string {
  return s.replace(EMAIL, '[email]').replace(BASE64_RUN, '[blob]').replace(LONG_DIGITS, '[number]');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.length > 20 ? `[array(${value.length})]` : value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase().replace(/[_-]/g, '')) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const consoleSink: Sink = (level, msg, fields) => {
  const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
  fn(`[nc] ${msg}`, fields);
};

export function createLogger(sink: Sink = consoleSink) {
  const log = (level: Level) => (msg: string, fields: Record<string, unknown> = {}) =>
    sink(level, redactString(msg), redact(fields) as Record<string, unknown>);
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const logger = createLogger();
