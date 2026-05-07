// lib/kv.js
// Thin wrapper around @upstash/redis that auto-detects Vercel's KV marketplace
// env vars (KV_REST_API_URL / KV_REST_API_TOKEN) or plain Upstash env vars
// (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
//
// All values are stored as JSON strings under namespaced keys:
//   ff:flow:<id>          -> Flow definition
//   ff:flows               -> set of all flow IDs (for listing)
//   ff:run:<runId>         -> Run record (status, logs, steps, timestamps)
//   ff:flow:<id>:runs      -> list of run IDs for that flow (newest first, capped)
//   ff:secrets             -> shared vault (object of key → value)
//   ff:webhook:<token>     -> flow ID that the public token maps to
//
// We use plain string SET/GET + a small "set" simulated with hash for flow-id list,
// since Upstash Redis fully supports SADD/SMEMBERS via REST.

import { Redis } from '@upstash/redis';

const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

let _redis = null;
function client() {
  if (_redis) return _redis;
  if (!url || !token) {
    throw new Error(
      'KV is not configured. Set KV_REST_API_URL + KV_REST_API_TOKEN ' +
      '(via Vercel Marketplace → Upstash Redis), or UPSTASH_REDIS_REST_URL + ' +
      'UPSTASH_REDIS_REST_TOKEN if hosting elsewhere.'
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

export const kv = {
  async get(key)         { return await client().get(key); },
  async set(key, value)  { return await client().set(key, value); },
  async del(...keys)     { return await client().del(...keys); },
  async sadd(key, ...m)  { return await client().sadd(key, ...m); },
  async srem(key, ...m)  { return await client().srem(key, ...m); },
  async smembers(key)    { return await client().smembers(key); },
  async lpush(key, ...v) { return await client().lpush(key, ...v); },
  async lrange(key,a,b)  { return await client().lrange(key, a, b); },
  async ltrim(key,a,b)   { return await client().ltrim(key, a, b); },
};

export const KEYS = {
  flow:        id => `ff:flow:${id}`,
  flowsSet:    () => `ff:flows`,
  run:         id => `ff:run:${id}`,
  flowRuns:    id => `ff:flow:${id}:runs`,
  secrets:     () => `ff:secrets`,
  webhookTok:  t  => `ff:webhook:${t}`,
};

export function isConfigured() {
  return Boolean(url && token);
}
