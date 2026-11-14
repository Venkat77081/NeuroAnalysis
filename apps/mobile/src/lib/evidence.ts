import type {
  DeviceCapabilities,
  Implementation,
  RecordingResult,
} from '@neurocapture/capture-kit';
import type { TakeMeta, TestConfig } from '@neurocapture/contracts-ts';
import { QUALITY_CORE_VERSION } from '@neurocapture/quality-core';
import type { SessionContext } from '../session/machine.ts';

export const APP_VERSION = '0.3.0';

/** meta.json for a take (contracts/meta.schema.json). No patient identifiers. */
export function buildMeta(args: {
  ctx: SessionContext;
  cfg: TestConfig;
  sessionConfigVersion: string;
  result: RecordingResult;
  takeNo: number;
  caps: DeviceCapabilities | null;
  implementation: Implementation;
  tier: TakeMeta['tier'];
  createdAt: string;
}): TakeMeta {
  const { ctx, cfg, result, caps } = args;
  const step = ctx.plan[ctx.index]!;
  const cam = caps?.cameras.find((c) => c.facing === cfg.camera.facing);
  return {
    schemaVersion: '1.0.0',
    takeId: result.takeId,
    sessionId: ctx.sessionId,
    testCode: step.code,
    side: step.side,
    take: args.takeNo,
    configVersion: cfg.configVersion,
    sessionConfigVersion: args.sessionConfigVersion,
    appVersion: APP_VERSION,
    pluginVersion: caps?.pluginVersion ?? '0.0.0',
    qualityCoreVersion: QUALITY_CORE_VERSION,
    implementation: args.implementation,
    device: caps
      ? {
          manufacturer: caps.device.manufacturer,
          model: caps.device.model,
          osName: caps.device.osName,
          osVersion: caps.device.osVersion,
        }
      : { manufacturer: 'unknown', model: 'unknown', osName: 'web', osVersion: 'unknown' },
    tier: args.implementation === 'native' ? args.tier : 'W',
    capabilities: (caps ?? {}) as Record<string, unknown>,
    timestamp: {
      source: cam?.timestampSource ?? 'SIMULATED',
      offsetNs: null,
      offsetSpreadMs: null,
    },
    camera: {
      facing: cfg.camera.facing,
      resolution: cfg.camera.resolution,
      targetFps: result.actualFps,
      orientation: cfg.camera.orientation,
    },
    medState: ctx.medState ?? 'NA',
    operatorId: ctx.operatorId,
    createdAt: args.createdAt,
  };
}
