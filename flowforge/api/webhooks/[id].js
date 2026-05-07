// api/webhooks/[id].js  →  ANY METHOD /api/webhooks/:webhookToken
//
// Public-by-design endpoint: the per-flow webhook token IS the auth. Anyone
// with the URL can trigger the flow. Body (JSON or form-encoded) is passed as
// the initial input to the first node, and is also surfaced as steps[0] so
// templates like {{0.email}} resolve from the trigger payload.

import { waitUntil } from '@vercel/functions';
import { json, error, preflightOk, readJson } from '../../lib/api.js';
import { flowIdForWebhookToken, getFlow, getSecrets, saveRun, markFlowRun } from '../../lib/store.js';
import { runFlow } from '../../lib/runner.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;

  // The dynamic segment uses [id] but the value is the webhook *token*, not the
  // flow id. We map token → flow id below. Naming the param 'id' just keeps the
  // file path simple.
  const { id: token } = req.query;
  if (!token) return error(res, 400, 'Missing webhook token');

  try {
    const flowId = await flowIdForWebhookToken(token);
    if (!flowId) return error(res, 404, 'Webhook not found');
    const flow = await getFlow(flowId);
    if (!flow) return error(res, 404, 'Flow not found');
    if (flow.enabled === false) return error(res, 423, 'Flow is disabled');

    // Collect a payload from any HTTP method:
    //   GET  → query params
    //   POST/PUT/PATCH → JSON body, falling back to query if no body
    //   DELETE → query params
    let payload = {};
    if (req.method === 'GET' || req.method === 'DELETE') {
      payload = { ...req.query };
      delete payload.id;
    } else {
      try { payload = await readJson(req); }
      catch { payload = { ...req.query }; delete payload.id; }
    }

    const queued = await saveRun(flow.id, {
      status: 'queued',
      startedAt: Date.now(),
      finishedAt: null,
      logs: [{
        ts: Date.now(),
        tag: 'info',
        msg: `Triggered by webhook (${req.method})`,
        payload,
      }],
      steps: {},
      trigger: 'webhook',
    });

    waitUntil((async () => {
      try {
        const secrets = await getSecrets();
        const result = await runFlow(flow, { secrets, initialInput: payload });
        // Surface the trigger payload as steps[0] so {{0.foo}} works for the
        // first downstream node — Make's webhook trigger has the same convention.
        result.steps[0] = payload;

        const { kv: rawKv, KEYS } = await import('../../lib/kv.js');
        await rawKv.set(KEYS.run(queued.id), { ...queued, ...result, status: result.status });
        await markFlowRun(flow.id, result.finishedAt);
      } catch (err) {
        const { kv: rawKv, KEYS } = await import('../../lib/kv.js');
        await rawKv.set(KEYS.run(queued.id), {
          ...queued,
          status: 'err',
          finishedAt: Date.now(),
          error: err.message,
          logs: [...queued.logs, { ts: Date.now(), tag: 'err', msg: err.message }],
        });
      }
    })());

    return json(res, 202, {
      ok: true,
      runId: queued.id,
      message: 'Flow queued. Poll /api/runs/' + queued.id + ' for status.',
    });
  } catch (e) {
    return error(res, 500, e.message);
  }
}
