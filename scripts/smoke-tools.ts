import assert from 'node:assert/strict';
import type { EventEnvelope, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import type { EgoWorld } from '../src/world.ts';

export function smokeTools(world: EgoWorld, host: WorldHost) {
  const results = new Map<string, ToolOutcome>();
  const pending = new Set<EventEnvelope>();
  let cursor = 0;
  const smokeHost: WorldHost = {
    ...host,
    pushEvent: async (event, opts) => {
      if (event.type === 'ego.result' && typeof event.meta?.resultId === 'string') {
        results.set(event.meta.resultId, { text: event.text.slice(event.text.indexOf('\n') + 1), blobs: event.blobs });
      }
      const stored = { ...await host.pushEvent(event, opts), cursor: ++cursor };
      if (event.type === 'ego.result') pending.add(stored);
      return stored;
    },
    drainPendingEvents: async filter => {
      const drained = [...pending].filter(filter);
      for (const event of drained) pending.delete(event);
      return drained;
    },
  };
  async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const tool = world.tools().find(t => t.name === `ego_${name}`);
    assert(tool, `Missing smoke tool ${name}`);
    const queued: EventEnvelope[] = [];
    const raw = await tool.handler(args, { role: 'smoke', log: host.log, queueExternalEvents: events => queued.push(...events) });
    const receipt = typeof raw === 'string' ? { text: raw } : raw;
    const id = /^See external event ego\.result ([\w-]+) for /.exec(receipt.text)?.[1];
    const delivered = id ? results.get(id) : undefined;
    assert(!receipt.failed, `${name}: ${delivered?.text ?? receipt.text}`);
    if (!id) return receipt;
    assert(delivered, `Missing external result for ${name}`);
    assert(queued.some(event => event.meta?.resultId === id), `Result for ${name} did not reach this session`);
    results.delete(id);
    return delivered;
  }
  return { host: smokeHost, call };
}
