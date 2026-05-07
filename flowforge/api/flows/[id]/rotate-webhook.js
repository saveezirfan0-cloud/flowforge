// api/flows/[id]/rotate-webhook.js  →  POST /api/flows/:id/rotate-webhook
import { json, error, preflightOk, requireAdmin } from '../../../lib/api.js';
import { rotateWebhookToken } from '../../../lib/store.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return error(res, 405, 'Method not allowed');

  const { id } = req.query;
  if (!id) return error(res, 400, 'Missing flow id');

  try {
    const flow = await rotateWebhookToken(id);
    if (!flow) return error(res, 404, 'Flow not found');
    return json(res, 200, { flow });
  } catch (e) {
    return error(res, 500, e.message);
  }
}
