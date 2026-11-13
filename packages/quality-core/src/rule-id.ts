/** Rule IDs are "<name>@<semver>", e.g. "in_safe_zone@1.0.0" (DEV_PLAN §9.1). */
const RULE_ID = /^([a-z_]+)@(\d+)\.(\d+)\.(\d+)$/;

export interface ParsedRuleId {
  name: string;
  version: string;
  major: number;
}

export function makeRuleId(name: string, version: string): string {
  const id = `${name}@${version}`;
  if (!RULE_ID.test(id)) throw new Error(`invalid rule id: ${id}`);
  return id;
}

export function parseRuleId(id: string): ParsedRuleId | null {
  const m = RULE_ID.exec(id);
  if (!m) return null;
  return { name: m[1]!, version: `${m[2]}.${m[3]}.${m[4]}`, major: Number(m[2]) };
}
