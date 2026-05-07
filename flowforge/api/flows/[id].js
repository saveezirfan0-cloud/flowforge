// api/flows/[id].js   →  GET / PUT / DELETE /api/flows/:id
import { json, error, preflightOk, readJson, requireAdmin } from '../../lib/api.js';
import { getFlow, updateFlow, deleteFlow } from '../../lib/store.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;
  if (!requireAdmin(req, res)) return;

  const { id } = req.query;
  if (!id) return error(res, 400, 'Missing flow id');

  try {
    if (req.method === 'GET') {
      const flow = await getFlow(id);
      if (!flow) return error(res, 404, 'Flow not found');
      return json(res, 200, { flow });
    }

    if (req.method === 'PUT') {
      const body = await readJson(req);
      const updated = await updateFlow(id, body);
      if (!updated) return error(res, 404, 'Flow not found');
      return json(res, 200, { flow: updated });
    }

    if (req.method === 'DELETE') {
      const ok = await deleteFlow(id);
      if (!ok) return error(res, 404, 'Flow not found');
      return json(res, 200, { ok: true });
    }

    return error(res, 405, 'Method not allowed');
  } catch (e) {
    return error(res, 500, e.message);
  }
}
