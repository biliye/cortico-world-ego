import { expect, it } from 'vitest';
import { EGO_DEFAULTS } from '../src/config.ts';
import { samplingOverride, samplingPlan, targetOffset } from '../src/sampling.ts';

it('includes the last endpoint for fractional intervals without an extra frame at exact decimal multiples', () => {
  const cfg = structuredClone(EGO_DEFAULTS);
  const plan = samplingPlan(cfg, samplingOverride({ action: 'watch', windowSec: 20, frameIntervalSec: 6 }));
  expect(Array.from({ length: plan.plannedFrames }, (_, i) => targetOffset(plan, i))).toEqual([0, 6, 12, 18, 20]);
  expect(samplingPlan(cfg, samplingOverride({ action: 'watch', windowSec: 10.2, frameIntervalSec: 1.7 })).plannedFrames).toBe(7);
});
it('keeps defaults and the legacy single-frame mode while temporary overrides do not mutate configuration', () => {
  const cfg = structuredClone(EGO_DEFAULTS);
  expect(samplingPlan(cfg)).toMatchObject({ windowSec: 15, frameIntervalSec: 5, plannedFrames: 4 });
  expect(samplingPlan(cfg, { windowSec: 60, frameIntervalSec: 20 }).plannedFrames).toBe(4);
  expect(cfg).toEqual(EGO_DEFAULTS);
  cfg.video.maxFrames = 1;
  const plan = samplingPlan(cfg); expect(plan.plannedFrames).toBe(1); expect(targetOffset(plan, 1)).toBe(15);
});
it.each([
  { windowSec: 2, frameIntervalSec: 1 }, { windowSec: 121, frameIntervalSec: 20 },
  { windowSec: 20 }, { frameIntervalSec: 10 }, { windowSec: 20, frameIntervalSec: 0 },
  { windowSec: 20, frameIntervalSec: NaN }, { windowSec: Infinity, frameIntervalSec: 10 },
  { windowSec: 20, frameIntervalSec: 21 }, { windowSec: 20, frameIntervalSec: 1 },
  { windowSec: '20', frameIntervalSec: 10 },
])('rejects invalid or excessive sampling before any browser effects: %j', (args: Record<string, unknown>) => {
  expect(() => samplingOverride({ action: 'watch', ...args })).toThrow();
});
it('requires a pair for tune and rejects sampling parameters on unrelated actions', () => {
  expect(() => samplingOverride({ action: 'tune' })).toThrow();
  expect(() => samplingOverride({ action: 'seek', windowSec: 20, frameIntervalSec: 10 })).toThrow();
  expect(samplingOverride({ action: 'watch' })).toBeUndefined();
});
