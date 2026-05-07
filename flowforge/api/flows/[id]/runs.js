// api/flows/[id]/runs.js  →  GET /api/flows/:id/runs?limit=20
import { json, error, preflightOk, requireAdmin } from '../../../lib/api.js';
import { getFlow, listRunsForFlow } from '../../../lib/store.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return error(res, 405, 'Method not allowed');

  const { id, limit } = req.query;
  if (!id) return error(res, 400, 'Missing flow id');

  try {
    const flow = await getFlow(id);
    if (!flow) return error(res, 404, 'Flow not found');

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const runs = await listRunsForFlow(id, lim);
    // Trim logs in the list view — caller fetches one run for full details.
    const trimmed = runs.map(r => ({
      id: r.id,
      flowId: r.flowId,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      trigger: r.trigger || 'manual',
      logCount: Array.isArray(r.logs) ? r.logs.length : 0,
      lastLog: Array.isArray(r.logs) && r.logs.length ? r.logs[r.logs.length - 1] : null,
      error: r.error || null,
    }));
    return json(res, 200, { runs: trimmed });
  } catch (e) {
    return error(res, 500, e.message);
  }
}
