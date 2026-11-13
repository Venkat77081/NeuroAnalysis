import testConfig from '../../../contracts/test-config.schema.json' with { type: 'json' };
import sessionConfig from '../../../contracts/session-config.schema.json' with { type: 'json' };
import quality from '../../../contracts/quality.schema.json' with { type: 'json' };
import meta from '../../../contracts/meta.schema.json' with { type: 'json' };
import landmarksHeader from '../../../contracts/landmarks-header.schema.json' with { type: 'json' };
import biomarkerRegistry from '../../../contracts/biomarker-registry.schema.json' with { type: 'json' };

/** All contract schemas, keyed by the name used on the CLI and in contracts/tests/<name>/. */
export const schemas = {
  'test-config': testConfig,
  'session-config': sessionConfig,
  quality,
  meta,
  'landmarks-header': landmarksHeader,
  'biomarker-registry': biomarkerRegistry,
} as const;

export type SchemaName = keyof typeof schemas;
export const schemaNames = Object.keys(schemas) as SchemaName[];

export function isSchemaName(name: string): name is SchemaName {
  return name in schemas;
}
