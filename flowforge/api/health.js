// api/health.js  →  GET /api/health
//
// Public: returns whether the deployment is configured correctly. Good for
// the frontend's startup banner — if KV isn't wired up, we tell the user
// before they start clicking around.

import { json } from '../lib/api.js';
import { isConfigured } from '../lib/kv.js';

export default async function handler(req, res) {
  return json(res, 200, {
    ok: true,
    kvConfigured: isConfigured(),
    requiresAdminToken: Boolean(process.env.FLOWFORGE_ADMIN_TOKEN),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
    now: Date.now(),
  });
}
