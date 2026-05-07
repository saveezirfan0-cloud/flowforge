// lib/util.js
import { randomUUID } from 'node:crypto';

export function newId(prefix = 'flow') {
  return `${prefix}_${randomUUID().split('-')[0]}${Date.now().toString(36)}`;
}

export function newWebhookToken() {
  // 24 char URL-safe token. Two UUID halves = enough entropy for public URLs.
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

/**
 * Decide whether a flow is due to run, given:
 *   schedule = { type: 'manual' | 'interval' | 'cron',
 *                intervalMinutes?: number,
 *                cronExpr?: '* * * * *' (5-field minute precision) }
 *   lastRunAt = epoch ms (or undefined if never run)
 *   now       = current epoch ms
 *
 * Returns true if the flow should fire on this tick.
 */
export function isDue(schedule, lastRunAt, now = Date.now()) {
  if (!schedule || schedule.type === 'manual') return false;
  if (schedule.type === 'interval') {
    const mins = Number(schedule.intervalMinutes) || 0;
    if (mins <= 0) return false;
    if (!lastRunAt) return true;
    return (now - lastRunAt) >= mins * 60 * 1000;
  }
  if (schedule.type === 'cron') {
    return cronMatches(schedule.cronExpr, now);
  }
  return false;
}

/**
 * Check whether a 5-field cron expression matches the given timestamp.
 *   minute hour dayOfMonth month dayOfWeek
 *
 * Supported syntax per field:
 *   *           any
 *   N           literal number
 *   N,M,K       comma list
 *   A-B         range
 *   * /N         step (every N units, anchored at 0)
 *   A-B/N       range with step
 *
 * Day-of-month and day-of-week follow standard cron semantics: if BOTH are
 * restricted (not '*'), either matching counts. If only one is restricted,
 * only it counts. Months are 1-12. Day-of-week is 0-7 with both 0 and 7 = Sunday.
 */
export function cronMatches(expr, ts) {
  if (!expr || typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const d = new Date(ts);
  const minute = d.getUTCMinutes();
  const hour   = d.getUTCHours();
  const dom    = d.getUTCDate();
  const month  = d.getUTCMonth() + 1;
  const dow    = d.getUTCDay();   // 0-6, Sunday = 0

  const okMin   = matchField(parts[0], minute, 0, 59);
  const okHour  = matchField(parts[1], hour,   0, 23);
  const okMon   = matchField(parts[3], month,  1, 12);
  if (!okMin || !okHour || !okMon) return false;

  const domRestricted = parts[2] !== '*';
  const dowRestricted = parts[4] !== '*';
  const okDom = matchField(parts[2], dom, 1, 31);
  const okDow = matchField(parts[4], dow, 0, 7) || (dow === 0 && matchField(parts[4], 7, 0, 7));

  if (domRestricted && dowRestricted) return okDom || okDow;
  if (domRestricted) return okDom;
  if (dowRestricted) return okDow;
  return true;
}

function matchField(field, value, min, max) {
  if (field === '*') return true;
  for (const piece of field.split(',')) {
    const stepMatch = piece.match(/^(.+?)\/(\d+)$/);
    let range = stepMatch ? stepMatch[1] : piece;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      lo = a; hi = b;
    } else {
      const n = Number(range);
      if (Number.isNaN(n)) continue;
      lo = n; hi = n;
    }
    if (value < lo || value > hi) continue;
    if ((value - lo) % step === 0) return true;
  }
  return false;
}

/**
 * Format epoch ms as a short ISO-ish timestamp for log display.
 */
export function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
