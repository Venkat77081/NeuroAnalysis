import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { schemas, type SchemaName } from './schemas.ts';

export interface ValidationIssue {
  /** JSON pointer to the offending field, e.g. "/camera/targetFps". "" means the document root. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
// 'tsType' is a type-generation hint for json-schema-to-typescript; Ajv ignores it.
ajv.addKeyword({ keyword: 'tsType', schemaType: 'string' });

const compiled = new Map<SchemaName, ValidateFunction>();

function getValidator(name: SchemaName): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    fn = ajv.compile(schemas[name] as object);
    compiled.set(name, fn);
  }
  return fn;
}

/** Turn an Ajv error into an issue whose path names the exact field (including missing/extra keys). */
export function toIssue(err: ErrorObject): ValidationIssue {
  let path = err.instancePath;
  let message = err.message ?? 'is invalid';
  const p = err.params as Record<string, unknown>;
  if (err.keyword === 'required' && typeof p.missingProperty === 'string') {
    path = `${path}/${p.missingProperty}`;
    message = 'is required but missing';
  } else if (err.keyword === 'additionalProperties' && typeof p.additionalProperty === 'string') {
    path = `${path}/${p.additionalProperty}`;
    message = 'is not an allowed field (check the spelling)';
  } else if (err.keyword === 'enum' && Array.isArray(p.allowedValues)) {
    message = `must be one of: ${p.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
  } else if (err.keyword === 'const') {
    message = `must be ${JSON.stringify(p.allowedValue)}`;
  } else if (err.keyword === 'contains') {
    message = 'must include "other"';
  }
  return { path, message };
}

/** Drop noise: oneOf/anyOf wrappers and duplicate messages. */
function simplify(errors: ErrorObject[]): ValidationIssue[] {
  const seen = new Set<string>();
  const out: ValidationIssue[] = [];
  const specific = errors.filter(
    (e) => e.keyword !== 'oneOf' && e.keyword !== 'anyOf' && e.keyword !== 'if',
  );
  for (const e of specific.length ? specific : errors) {
    const issue = toIssue(e);
    const key = `${issue.path}|${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

export function validate(name: SchemaName, data: unknown): ValidationResult {
  const fn = getValidator(name);
  const valid = fn(data) as boolean;
  return { valid, issues: valid ? [] : simplify(fn.errors ?? []) };
}

export function formatIssues(file: string, issues: ValidationIssue[]): string {
  return issues.map((i) => `${file}: field "${i.path || '/'}" ${i.message}`).join('\n');
}
