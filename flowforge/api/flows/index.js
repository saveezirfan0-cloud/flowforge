// api/flows/index.js   →  GET /api/flows, POST /api/flows
import { json, error, preflightOk, readJson, requireAdmin } from '../../lib/api.js';
import { listFlows, createFlow } from '../../lib/store.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const flows = await listFlows();
      // Strip workflow body from list response — the editor fetches the full flow
      // when it opens. Keeps the list response small even for big flows.
      return json(res, 200, {
        flows: flows.map(f => ({
          id: f.id,
          name: f.name,
          enabled: f.enabled,
          schedule: f.schedule,
          updatedAt: f.updatedAt,
          lastRunAt: f.lastRunAt,
          nodeCount: Array.isArray(f.workflow) ? f.workflow.length : 0,
        })),
      });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const flow = await createFlow({
        name: body.name,
        workflow: body.workflow || [],
        scenarioMeta: body.scenarioMeta || null,
        schedule: body.schedule || { type: 'manual' },
      });
      return json(res, 201, { flow });
    }

    return error(res, 405, 'Method not allowed');
  } catch (e) {
    return error(res, 500, e.message);
  }
}
