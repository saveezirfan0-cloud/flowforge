// api/flows/[id]/run.js   →  POST /api/flows/:id/run
//
// Triggers a background run. Returns 202 + the queued run record immediately;
// the actual flow execution continues after the response is sent, thanks to
// Vercel's waitUntil(). Status, logs, and final output land in /api/runs/:runId.
//
// Body (optional):
//   { input: any }   – passed as the initial input to the first node.
//                      Useful for "trigger with payload" workflows.

import { waitUntil } from '@vercel/functions';
import { json, error, preflightOk, readJson, requireAdmin } from '../../../lib/api.js';
import { getFlow, getSecrets, saveRun, markFlowRun } from '../../../lib/store.js';
import { runFlow } from '../../../lib/runner.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return error(res, 405, 'Method not allowed');

  const { id } = req.query;
  if (!id) return error(res, 400, 'Missing flow id');

  try {
    const flow = await getFlow(id);
    if (!flow) return error(res, 404, 'Flow not found');

    const body = req.headers['content-length'] && Number(req.headers['content-length']) > 0
      ? await readJson(req)
      : {};
    const initialInput = body.input ?? null;

    // Persist a "queued" record so the UI can poll while we wait for execution.
    // We save the *final* result after runFlow resolves, not before, since runFlow
    // produces the full record in one go. To keep the user updated we save twice:
    // once at queued, once at done. The runId stays the same — saveRun returns the
    // record so we can fetch and update.
    const queued = await saveRun(flow.id, {
      status: 'queued',
      startedAt: Date.now(),
      finishedAt: null,
      logs: [{ ts: Date.now(), tag: 'info', msg: 'Queued for background execution' }],
      steps: {},
      trigger: 'manual',
    });

    // Background execution: do NOT await this in the response path.
    waitUntil((async () => {
      try {
        const secrets = await getSecrets();
        const result = await runFlow(flow, { secrets, initialInput });
        // Overwrite the queued record with final outcome. We re-use the same
        // run id so lookups against it return the finished record. saveRun
        // creates a new id, so we go through kv directly here.
        const { kv: rawKv, KEYS } = await import('../../../lib/kv.js');
        await rawKv.set(KEYS.run(queued.id), { ...queued, ...result, status: result.status });
        await markFlowRun(flow.id, result.finishedAt);
      } catch (err) {
        const { kv: rawKv, KEYS } = await import('../../../lib/kv.js');
        await rawKv.set(KEYS.run(queued.id), {
          ...queued,
          status: 'err',
          finishedAt: Date.now(),
          error: err.message,
          logs: [...queued.logs, { ts: Date.now(), tag: 'err', msg: err.message }],
        });
      }
    })());

    return json(res, 202, { run: queued });
  } catch (e) {
    return error(res, 500, e.message);
  }
}
