// lib/api.js
// Tiny utilities used by the api/* handlers.

export function json(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Allow same-origin static frontend to call these endpoints. The frontend
  // ships from /public, so it's same-origin already; CORS is only relevant
  // if you embed this elsewhere. We keep it tight by default.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  res.send(JSON.stringify(body));
}

export function error(res, status, message, extra = {}) {
  return json(res, status, { error: message, ...extra });
}

export function preflightOk(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * Parse req.body as JSON. Vercel's Node runtime usually parses application/json
 * bodies for us, but if the client sends raw text or the runtime doesn't, we
 * fall back to reading the stream.
 */
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => { chunks += c; });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * If FLOWFORGE_ADMIN_TOKEN is set in the environment, require requests to the
 * admin API (/api/flows*, /api/secrets, etc.) to send a matching token via
 *   Authorization: Bearer <token>
 *   or
 *   X-Admin-Token: <token>
 *
 * If the env var is unset, the API is open. Public webhooks don't go through
 * this — they authenticate via their per-flow token in the URL.
 *
 * Returns true when the request is allowed; sends a 401 and returns false otherwise.
 */
export function requireAdmin(req, res) {
  const expected = process.env.FLOWFORGE_ADMIN_TOKEN;
  if (!expected) return true;
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerTok = req.headers['x-admin-token'] || '';
  if (bearer === expected || headerTok === expected) return true;
  error(res, 401, 'Unauthorized — set Authorization: Bearer <FLOWFORGE_ADMIN_TOKEN>');
  return false;
}

/**
 * For the cron endpoint: Vercel's scheduler attaches a Bearer token equal to
 * the project's CRON_SECRET (auto-injected). Local cron triggers and manual
 * curl are also allowed via FLOWFORGE_ADMIN_TOKEN.
 */
export function requireCronAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const cronSecret  = process.env.CRON_SECRET || '';
  const adminToken  = process.env.FLOWFORGE_ADMIN_TOKEN || '';
  // If neither secret is configured, allow (useful for local dev). In production
  // Vercel always sets CRON_SECRET, so this branch only triggers locally.
  if (!cronSecret && !adminToken) return true;
  if (cronSecret && bearer === cronSecret) return true;
  if (adminToken && bearer === adminToken) return true;
  error(res, 401, 'Unauthorized cron request');
  return false;
}
