import { bounded, type EgoConfigSection } from './config.ts';

export interface SamplingOverride { windowSec: number; frameIntervalSec: number }
export interface SamplingPlan extends SamplingOverride { plannedFrames: number; frameWidth: number; danmaku: boolean }

/** Include both window endpoints; tolerate floating-point noise at exact multiples. */
export function frameCount(windowSec: number, frameIntervalSec: number): number {
  return Math.ceil(windowSec / frameIntervalSec - 1e-9) + 1;
}
export function samplingOverride(args: Record<string, unknown>): SamplingOverride | undefined {
  if (args.windowSec === undefined && args.frameIntervalSec === undefined && args.action !== 'tune') return;
  if (!['watch', 'tune'].includes(String(args.action))) throw new Error('Sampling parameters are supported only by watch and tune.');
  const { windowSec, frameIntervalSec } = args;
  if (typeof windowSec !== 'number' || !Number.isFinite(windowSec) || windowSec < 10 || windowSec > 120) throw new Error('windowSec must be a finite number from 10 to 120; provide both sampling parameters.');
  if (typeof frameIntervalSec !== 'number' || !Number.isFinite(frameIntervalSec) || frameIntervalSec < 1 || frameIntervalSec > windowSec) throw new Error('frameIntervalSec must be a finite number from 1 to windowSec; provide both sampling parameters.');
  if (frameCount(windowSec, frameIntervalSec) > 9) throw new Error(`Sampling exceeds 9 frames. Increase frameIntervalSec to at least ${windowSec / 8} seconds, or reduce windowSec.`);
  return { windowSec, frameIntervalSec };
}
export function samplingPlan(cfg: EgoConfigSection, override?: SamplingOverride): SamplingPlan {
  const windowSec = bounded(cfg.video.intervalMs, 10000, 120000, 15000) / 1000;
  const plannedFrames = bounded(cfg.video.maxFrames, 1, 9, 4);
  return { windowSec, frameIntervalSec: windowSec / Math.max(1, plannedFrames - 1), plannedFrames,
    ...override, ...(override ? { plannedFrames: frameCount(override.windowSec, override.frameIntervalSec) } : {}),
    frameWidth: bounded(cfg.video.frameWidth, 240, 1280, 640), danmaku: cfg.video.danmaku !== false };
}
export function captureOptions(plan: SamplingPlan) {
  return { maxFrames: plan.plannedFrames, frameWidth: plan.frameWidth, windowMs: plan.windowSec * 1000, danmaku: plan.danmaku };
}
export function targetOffset(plan: SamplingPlan, index: number): number {
  return plan.plannedFrames === 1 ? plan.windowSec : Math.min(index * plan.frameIntervalSec, plan.windowSec);
}
export function samplingSummary(plan: SamplingPlan) {
  return { windowSec: plan.windowSec, frameIntervalSec: plan.frameIntervalSec, plannedFrames: plan.plannedFrames };
}
