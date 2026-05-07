// lib/store.js
// High-level store operations: flow CRUD, run history. Sits on top of lib/kv.js.

import { kv, KEYS } from './kv.js';
import { newId, newWebhookToken } from './util.js';

const MAX_RUNS_PER_FLOW = 50;  // keep run history bounded

// ---------- Flows ----------

export async function listFlows() {
  const ids = (await kv.smembers(KEYS.flowsSet())) || [];
  if (ids.length === 0) return [];
  // Fetch each flow's metadata in parallel
  const records = await Promise.all(ids.map(id => kv.get(KEYS.flow(id))));
  return records
    .filter(Boolean)
    // Sort newest-edited first
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getFlow(id) {
  return await kv.get(KEYS.flow(id));
}

export async function createFlow({ name, workflow = [], scenarioMeta = null, schedule = null } = {}) {
  const id = newId('flow');
  const webhookToken = newWebhookToken();
  const now = Date.now();
  const flow = {
    id,
    name: name || 'untitled scenario',
    workflow,
    scenarioMeta,
    schedule: schedule || { type: 'manual' },
    enabled: true,
    webhookToken,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
  };
  await kv.set(KEYS.flow(id), flow);
  await kv.sadd(KEYS.flowsSet(), id);
  await kv.set(KEYS.webhookTok(webhookToken), id);
  return flow;
}

export async function updateFlow(id, patch) {
  const existing = await getFlow(id);
  if (!existing) return null;
  // Don't let callers overwrite the webhook token through a normal save —
  // it's rotated via a dedicated endpoint to avoid accidental URL breakage.
  const { webhookToken: _, id: __, createdAt: ___, ...allowed } = patch;
  const merged = { ...existing, ...allowed, updatedAt: Date.now() };
  await kv.set(KEYS.flow(id), merged);
  return merged;
}

export async function deleteFlow(id) {
  const flow = await getFlow(id);
  if (!flow) return false;
  await kv.del(KEYS.flow(id));
  await kv.srem(KEYS.flowsSet(), id);
  if (flow.webhookToken) await kv.del(KEYS.webhookTok(flow.webhookToken));
  // Run history left in place — it'll age out naturally as KEYS.flowRuns is
  // a list with MAX_RUNS_PER_FLOW cap. If a future flow gets the same id (won't
  // happen with random IDs), the list will show its old runs until trimmed.
  return true;
}

export async function rotateWebhookToken(id) {
  const flow = await getFlow(id);
  if (!flow) return null;
  if (flow.webhookToken) await kv.del(KEYS.webhookTok(flow.webhookToken));
  const newToken = newWebhookToken();
  await kv.set(KEYS.webhookTok(newToken), id);
  return await updateFlow(id, { webhookToken: newToken });
}

export async function flowIdForWebhookToken(token) {
  if (!token) return null;
  return await kv.get(KEYS.webhookTok(token));
}

export async function markFlowRun(id, ts = Date.now()) {
  return await updateFlow(id, { lastRunAt: ts });
}

// ---------- Runs ----------

export async function saveRun(flowId, run) {
  const runId = newId('run');
  const record = { id: runId, flowId, ...run };
  await kv.set(KEYS.run(runId), record);
  await kv.lpush(KEYS.flowRuns(flowId), runId);
  await kv.ltrim(KEYS.flowRuns(flowId), 0, MAX_RUNS_PER_FLOW - 1);
  return record;
}

export async function getRun(runId) {
  return await kv.get(KEYS.run(runId));
}

export async function listRunsForFlow(flowId, limit = 20) {
  const ids = (await kv.lrange(KEYS.flowRuns(flowId), 0, Math.max(0, limit - 1))) || [];
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map(id => kv.get(KEYS.run(id))));
  return records.filter(Boolean);
}

// ---------- Secrets vault ----------

export async function getSecrets() {
  return (await kv.get(KEYS.secrets())) || {};
}

export async function setSecrets(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('secrets must be an object');
  await kv.set(KEYS.secrets(), obj);
  return obj;
}
