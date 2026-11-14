import { createCaptureKit, MockCaptureKit, type Implementation } from '@neurocapture/capture-kit';
import type { TestConfig } from '@neurocapture/contracts-ts';
import type { ScenarioName, Side, TakeVariant } from '@neurocapture/quality-core';
import { createCameraOwner } from './camera-owner.ts';

const params = new URLSearchParams(globalThis.location?.search ?? '');

/** `?impl=mock|webcam|native` overrides the platform default (dev only). */
function preferredImpl(): Implementation | undefined {
  const p = params.get('impl');
  return p === 'mock' || p === 'webcam' || p === 'native' ? p : undefined;
}

/** `?mockSpeed=20` speeds up mock recordings and UI countdowns (development and e2e only). */
const requested = Number(params.get('mockSpeed') ?? '1');
export const capture = createCaptureKit(preferredImpl(), { speed: requested > 0 ? requested : 1 });
export const clockSpeed = capture.implementation === 'mock' && requested > 0 ? requested : 1;
export const camera = createCameraOwner(capture.kit);

/**
 * Mock mode: frames are synthetic positioning scenarios for the current test (M5).
 * `?scenario=too_far` etc. picks a failure; default "good" so the gate opens.
 */
export function applyMockScenario(test: TestConfig, side: Side | null): void {
  if (!(capture.kit instanceof MockCaptureKit)) return;
  const name = (params.get('scenario') ?? 'good') as ScenarioName;
  // ?take=interrupted|wrong|slow|fast: how the mock patient performs while recording.
  const take = (params.get('take') ?? 'normal') as TakeVariant;
  capture.kit.setScenario({ test, name, side, take });
}

/** §15 StorageLow limits for startRecording, from session.json `storage`. */
export function storageLimits(s?: { minFreeGbToStart: number; stopBelowMb: number }): {
  minFreeBytes?: number;
  stopBelowFreeBytes?: number;
} {
  return s
    ? { minFreeBytes: s.minFreeGbToStart * 1e9, stopBelowFreeBytes: s.stopBelowMb * 1e6 }
    : {};
}

/** `?freeGb=1.2` sets the mock's free storage (StorageLow e2e). */
const freeGb = Number(params.get('freeGb'));
if (capture.kit instanceof MockCaptureKit && freeGb > 0) capture.kit.freeBytes = freeGb * 1e9;

// Mock mode only: e2e tests reach the mock (e.g. simulateBackground) through this handle.
if (capture.implementation === 'mock')
  (globalThis as { __ncMock?: unknown }).__ncMock = capture.kit;
