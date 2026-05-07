// api/runs/[runId].js  →  GET /api/runs/:runId
import { json, error, preflightOk, requireAdmin } from '../../lib/api.js';
import { getRun } from '../../lib/store.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return error(res, 405, 'Method not allowed');

  const { runId } = req.query;
  if (!runId) return error(res, 400, 'Missing run id');

  try {
    const run = await getRun(runId);
    if (!run) return error(res, 404, 'Run not found');
    return json(res, 200, { run });
  } catch (e) {
    return error(res, 500, e.message);
  }
}
