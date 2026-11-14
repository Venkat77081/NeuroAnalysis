import testConfig from '../../../contracts/test-config.schema.json' with { type: 'json' };
import sessionConfig from '../../../contracts/session-config.schema.json' with { type: 'json' };
import quality from '../../../contracts/quality.schema.json' with { type: 'json' };
import meta from '../../../contracts/meta.schema.json' with { type: 'json' };
import landmarksHeader from '../../../contracts/landmarks-header.schema.json' with { type: 'json' };
import biomarkerRegistry from '../../../contracts/biomarker-registry.schema.json' with { type: 'json' };
import benchmarkReport from '../../../contracts/benchmark-report.schema.json' with { type: 'json' };
import deviceTiers from '../../../contracts/device-tiers.schema.json' with { type: 'json' };
import qualityConfig from '../../../contracts/quality-config.schema.json' with { type: 'json' };
import streamHeader from '../../../contracts/stream-header.schema.json' with { type: 'json' };

/** All contract schemas, keyed by the name used on the CLI and in contracts/tests/<name>/. */
export const schemas = {
  'test-config': testConfig,
  'session-config': sessionConfig,
  quality,
  meta,
  'landmarks-header': landmarksHeader,
  'biomarker-registry': biomarkerRegistry,
  'benchmark-report': benchmarkReport,
  'device-tiers': deviceTiers,
  'stream-header': streamHeader,
  'quality-config': qualityConfig,
} as const;

export type SchemaName = keyof typeof schemas;
export const schemaNames = Object.keys(schemas) as SchemaName[];

export function isSchemaName(name: string): name is SchemaName {
  return name in schemas;
}
