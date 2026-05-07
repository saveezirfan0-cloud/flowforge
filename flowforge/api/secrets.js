// api/secrets.js  →  GET / PUT /api/secrets
import { json, error, preflightOk, readJson, requireAdmin } from '../lib/api.js';
import { getSecrets, setSecrets } from '../lib/store.js';

export default async function handler(req, res) {
  if (preflightOk(req, res)) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const secrets = await getSecrets();
      // Return secret KEYS but mask the values — the editor only needs to know
      // which keys exist when previewing, and we never expose values back to
      // anyone who hits this endpoint without rotating them first.
      const masked = {};
      for (const [k, v] of Object.entries(secrets)) {
        masked[k] = typeof v === 'string' && v.length > 8
          ? v.slice(0, 4) + '…' + v.slice(-2)
          : '••••';
      }
      return json(res, 200, { keys: Object.keys(secrets), masked });
    }

    if (req.method === 'PUT') {
      const body = await readJson(req);
      // Body shape: { set: { KEY: 'value', ... }, delete: ['KEY1', ...] }
      const current = await getSecrets();
      const updated = { ...current };
      if (body.set && typeof body.set === 'object') {
        for (const [k, v] of Object.entries(body.set)) updated[k] = String(v);
      }
      if (Array.isArray(body.delete)) {
        for (const k of body.delete) delete updated[k];
      }
      await setSecrets(updated);
      return json(res, 200, { keys: Object.keys(updated) });
    }

    return error(res, 405, 'Method not allowed');
  } catch (e) {
    return error(res, 500, e.message);
  }
}
