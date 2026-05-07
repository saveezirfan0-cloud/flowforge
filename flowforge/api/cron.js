// api/cron.js  →  GET /api/cron
//
// Vercel calls this on the schedule defined in vercel.json (every minute).
// We scan all enabled flows and fire any whose schedule says "now". Each
// triggered flow runs in the background via waitUntil — the cron response
// returns as soon as the scan finishes, regardless of how long the actual
// flows take.

import { waitUntil } from '@vercel/functions';
import { json, error, requireCronAuth } from '../lib/api.js';
import { listFlows, getSecrets, saveRun, markFlowRun } from '../lib/store.js';
import { runFlow } from '../lib/runner.js';
import { isDue } from '../lib/util.js';

export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;

  try {
    const flows = await listFlows();
    const now = Date.now();
    const triggered = [];
    const skipped = [];

    for (const flow of flows) {
      if (flow.enabled === false) { skipped.push({ id: flow.id, reason: 'disabled' }); continue; }
      if (!flow.schedule || flow.schedule.type === 'manual') {
        skipped.push({ id: flow.id, reason: 'manual' });
        continue;
      }
      if (!isDue(flow.schedule, flow.lastRunAt, now)) {
        skipped.push({ id: flow.id, reason: 'not-due' });
        continue;
      }
      triggered.push(flow.id);
      // Fire each flow in the background — the cron response returns
      // immediately. Each flow has its own waitUntil-protected execution.
      waitUntil(executeFlow(flow));
    }

    return json(res, 200, {
      tickAt: now,
      triggered,
      skippedCount: skipped.length,
    });
  } catch (e) {
    return error(res, 500, e.message);
  }
}

async function executeFlow(flow) {
  // Optimistically mark "lastRunAt = now" BEFORE running. If we waited until
  // after, a long-running cron'd flow could double-fire on the next tick.
  await markFlowRun(flow.id, Date.now());

  const queued = await saveRun(flow.id, {
    status: 'queued',
    startedAt: Date.now(),
    finishedAt: null,
    logs: [{ ts: Date.now(), tag: 'info', msg: 'Triggered by cron' }],
    steps: {},
    trigger: 'cron',
  });

  try {
    const secrets = await getSecrets();
    const result = await runFlow(flow, { secrets });
    const { kv, KEYS } = await import('../lib/kv.js');
    await kv.set(KEYS.run(queued.id), { ...queued, ...result, status: result.status });
    await markFlowRun(flow.id, result.finishedAt);
  } catch (err) {
    const { kv, KEYS } = await import('../lib/kv.js');
    await kv.set(KEYS.run(queued.id), {
      ...queued,
      status: 'err',
      finishedAt: Date.now(),
      error: err.message,
      logs: [...queued.logs, { ts: Date.now(), tag: 'err', msg: err.message }],
    });
  }
}
