// lib/runner.js
// Server-side flow runner. Ports the runtime that lives in public/index.html
// into a Node-compatible module so flows can execute headless on Vercel.
//
// Supported node types: set, http, filter, router, sleep, iterator, aggregator.
// Make-imported modules are pre-mapped to one of these on import — see the
// frontend's mapMakeModule() — so the runner never needs to know about
// airtable:* / util:* / etc. directly. Unknown types are skipped with a warning.
//
// Differences from the browser runner:
//   - No DOM (no "running" CSS class, no inspector hooks).
//   - log() collects entries into the run record instead of printing to a panel.
//   - Secrets come from KV (loaded once per run) instead of localStorage.
//   - Airtable schema cache is per-run (a fresh Map each time).

// ============================================================
//   Make expression engine — mirrors evalMakeExpr from the UI
// ============================================================

const MAKE_CONSTS = {
  space: ' ', newline: '\n', tab: '\t', emptystring: '', CR: '\r', LF: '\n',
};

function isTruthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function normalizeDateString(s) {
  if (typeof s !== 'string' || !s) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+\-]\d{2}:?\d{2})$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:00.000Z`;
  m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  if (m) return m[1] + 'Z';
  m = s.match(/^(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const date = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    const time = `${m[4].padStart(2,'0')}:${m[5]}:${m[6] || '00'}.000Z`;
    return `${date}T${time}`;
  }
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return s;
}

const MAKE_FUNCTIONS = {
  toString: v => {
    if (v == null) return '';
    if (Array.isArray(v)) return '[' + v.map(x => x == null ? '' : String(x)).join(',') + ']';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  },
  upper:      v => String(v ?? '').toUpperCase(),
  lower:      v => String(v ?? '').toLowerCase(),
  trim:       v => String(v ?? '').trim(),
  length:     v => Array.isArray(v) || typeof v === 'string'
                  ? v.length
                  : (v && typeof v === 'object' ? Object.keys(v).length : 0),
  replace:    (s, search, repl) => String(s ?? '').split(String(search ?? '')).join(String(repl ?? '')),
  substring:  (s, a, b) => String(s ?? '').substring(Number(a) || 0, b !== undefined ? Number(b) : undefined),
  indexOf:    (s, q) => String(s ?? '').indexOf(String(q ?? '')),
  contains:   (s, q) => String(s ?? '').includes(String(q ?? '')),
  startsWith: (s, q) => String(s ?? '').startsWith(String(q ?? '')),
  endsWith:   (s, q) => String(s ?? '').endsWith(String(q ?? '')),
  split:      (s, sep) => String(s ?? '').split(String(sep ?? '')),
  join:       (arr, sep) => Array.isArray(arr) ? arr.join(String(sep ?? ',')) : String(arr ?? ''),
  capitalize: v => { const s = String(v ?? ''); return s.charAt(0).toUpperCase() + s.slice(1); },
  toNumber:   v => Number(v ?? 0),
  add:  (a, b) => Number(a) + Number(b),
  sub:  (a, b) => Number(a) - Number(b),
  mul:  (a, b) => Number(a) * Number(b),
  div:  (a, b) => Number(a) / Number(b),
  round: v => Math.round(Number(v)),
  floor: v => Math.floor(Number(v)),
  ceil:  v => Math.ceil(Number(v)),
  get: (coll, idx) => {
    if (Array.isArray(coll)) {
      const i = Number(idx);
      return Number.isFinite(i) ? coll[i - 1] : coll.find(x => x?.id === idx);
    }
    if (coll && typeof coll === 'object') return coll[idx];
    return undefined;
  },
  first: v => Array.isArray(v) ? v[0] : v,
  last:  v => Array.isArray(v) ? v[v.length - 1] : v,
  map:   (arr, key) => Array.isArray(arr) ? arr.map(x => x?.[key]) : [],
  if:       (cond, t, f) => isTruthy(cond) ? t : f,
  ifempty:  (val, fb)    => (val === undefined || val === null || val === '') ? fb : val,
  emptystring: v => (v === undefined || v === null || v === ''),
  not: v => !isTruthy(v),
  now: () => new Date().toISOString(),
  formatDate: (d, fmt) => {
    const date = d instanceof Date ? d : new Date(normalizeDateString(String(d)));
    if (isNaN(date)) return String(d ?? '');
    const pad = n => String(n).padStart(2, '0');
    return String(fmt || 'YYYY-MM-DD')
      .replace(/YYYY/g, date.getFullYear())
      .replace(/MM/g, pad(date.getMonth() + 1))
      .replace(/DD/g, pad(date.getDate()))
      .replace(/HH/g, pad(date.getHours()))
      .replace(/mm/g, pad(date.getMinutes()))
      .replace(/ss/g, pad(date.getSeconds()));
  },
  parseDate: s => normalizeDateString(s),
  parseJSON: s => { try { return JSON.parse(String(s)); } catch { return s; } },
};

function splitMakeArgs(s) {
  const args = [];
  let depth = 0, inStr = false, current = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (inStr && s[i + 1] === '"') { current += '""'; i++; continue; }
      inStr = !inStr;
      current += c;
    } else if (!inStr && c === '(') { depth++; current += c; }
    else if (!inStr && c === ')') { depth--; current += c; }
    else if (!inStr && c === ';' && depth === 0) {
      args.push(current.trim()); current = '';
    } else { current += c; }
  }
  if (current.trim() || args.length > 0) args.push(current.trim());
  return args;
}

function splitTopLevelPlus(s) {
  const parts = [];
  let depth = 0, inStr = false, current = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (inStr && s[i + 1] === '"') { current += '""'; i++; continue; }
      inStr = !inStr;
      current += c;
    } else if (!inStr && c === '(') { depth++; current += c; }
    else if (!inStr && c === ')') { depth--; current += c; }
    else if (!inStr && c === '+' && depth === 0) {
      parts.push(current.trim()); current = '';
    } else { current += c; }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function evalMakeExpr(body, refResolverFn) {
  body = String(body).trim();
  if (!body) return '';
  if (body.indexOf('+') >= 0) {
    const parts = splitTopLevelPlus(body);
    if (parts.length > 1) {
      const vals = parts.map(p => evalMakeExpr(p, refResolverFn));
      if (vals.every(v => typeof v === 'number' || (!isNaN(Number(v)) && v !== '' && v != null))) {
        return vals.reduce((a, b) => Number(a) + Number(b), 0);
      }
      return vals.map(v => v == null ? '' : String(v)).join('');
    }
  }
  const fnMatch = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)\s*$/);
  if (fnMatch) {
    const name = fnMatch[1];
    const fn = MAKE_FUNCTIONS[name];
    const args = splitMakeArgs(fnMatch[2]).map(a => evalMakeExpr(a, refResolverFn));
    if (!fn) return `[unknown:${name}]`;
    try { return fn(...args); } catch (e) { return `[err:${name}:${e.message}]`; }
  }
  if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) {
    return body.slice(1, -1).replace(/""/g, '"');
  }
  if (/^-?\d+(\.\d+)?$/.test(body)) return Number(body);
  if (body === 'true') return true;
  if (body === 'false') return false;
  if (body === 'null') return null;
  if (Object.prototype.hasOwnProperty.call(MAKE_CONSTS, body)) return MAKE_CONSTS[body];
  if (/^\d/.test(body) || /^[A-Z][A-Z0-9_]*(\.|$)/.test(body)) {
    return refResolverFn('{{' + body + '}}');
  }
  return body;
}

function resolvePath(data, path) {
  if (data === undefined || data === null) return undefined;
  if (!path) return data;
  const parts = path.split('.');
  let current = data;
  for (let i = 0; i < parts.length; i++) {
    if (current === undefined || current === null) return undefined;
    let part = parts[i].trim();
    let pluck = false;
    if (part.endsWith('[]')) { pluck = true; part = part.slice(0, -2); }
    if (part) {
      let next = current[part];
      if (next === undefined && current && typeof current === 'object' && !Array.isArray(current)) {
        const norm = s => String(s).toLowerCase().replace(/[\s_-]/g, '');
        const target = norm(part);
        for (const k of Object.keys(current)) {
          if (norm(k) === target) { next = current[k]; break; }
        }
      }
      current = next;
    }
    if (pluck) {
      if (!Array.isArray(current)) return [];
      const rest = parts.slice(i + 1).join('.');
      if (!rest) return current;
      return current.map(item => resolvePath(item, rest));
    }
  }
  return current;
}

function refResolver(steps, secrets) {
  return ref => {
    const m = String(ref).match(/^\{\{(.+?)(?:\.(.+?))?\}\}$/);
    if (!m) return ref;
    const key = m[1], path = m[2];
    if (/^\d+$/.test(key)) return resolvePath(steps[key], path);
    return resolvePath(secrets[key], path);
  };
}

function resolveTemplate(str, steps, secrets) {
  if (typeof str !== 'string') return str;
  const r = refResolver(steps, secrets);
  return str.replace(/\{\{([^{}]+?)\}\}/g, (m, inner) => {
    let v;
    const trimmed = inner.trim();
    const hasFn = /[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(trimmed);
    const hasPlus = trimmed.indexOf('+') >= 0;
    const hasConst = /\b(space|newline|tab|emptystring|CR|LF)\b/.test(trimmed);
    if (hasFn || hasPlus || hasConst) {
      try { v = evalMakeExpr(inner, r); } catch { v = undefined; }
    } else {
      v = r(`{{${inner}}}`);
    }
    if (v === undefined) return m;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function deepResolveTemplates(value, steps, secrets, depth = 0) {
  if (depth > 5 || value == null) return value;
  if (typeof value === 'string') {
    if (value.indexOf('{{') < 0) return value;
    const resolved = resolveTemplate(value, steps, secrets);
    if (resolved !== value && resolved.indexOf('{{') >= 0) {
      return deepResolveTemplates(resolved, steps, secrets, depth + 1);
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map(v => deepResolveTemplates(v, steps, secrets, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepResolveTemplates(value[k], steps, secrets, depth + 1);
    return out;
  }
  return value;
}

function walkResolveInJSON(value, steps, secrets) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const fullMatch = value.match(/^\s*\{\{([^{}]+?)\}\}\s*$/);
    if (fullMatch) {
      const inner = fullMatch[1];
      const trimmed = inner.trim();
      const r = refResolver(steps, secrets);
      let v;
      const hasFn = /[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(trimmed);
      const hasPlus = trimmed.indexOf('+') >= 0;
      const hasConst = /\b(space|newline|tab|emptystring|CR|LF)\b/.test(trimmed);
      if (hasFn || hasPlus || hasConst) {
        try { v = evalMakeExpr(inner, r); } catch { v = undefined; }
      } else {
        v = r(`{{${inner}}}`);
      }
      if (v === undefined) return value;
      if (Array.isArray(v) && v.length === 1) {
        const only = v[0];
        if (only !== null && typeof only === 'object') { /* keep */ }
        else return only;
      }
      if (Array.isArray(v) && v.length === 0) return undefined;
      if (v !== null && typeof v === 'object') return JSON.stringify(v);
      return v;
    }
    if (value.indexOf('{{') >= 0) return resolveTemplate(value, steps, secrets);
    return value;
  }
  if (Array.isArray(value)) return value.map(x => walkResolveInJSON(x, steps, secrets));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkResolveInJSON(v, steps, secrets);
    return out;
  }
  return value;
}

function walkNormalize(obj) {
  if (obj === null || typeof obj !== 'object') return;
  const target = Array.isArray(obj) ? obj : obj;
  const keys = Array.isArray(target) ? target.map((_, i) => i) : Object.keys(target);
  for (const k of keys) {
    if (typeof target[k] === 'string') target[k] = normalizeDateString(target[k]);
    else walkNormalize(target[k]);
  }
}

function walkStripTime(obj) {
  if (obj === null || typeof obj !== 'object') return;
  const stripOne = v => {
    if (typeof v !== 'string') return v;
    const m = v.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/);
    return m ? m[1] : v;
  };
  const target = Array.isArray(obj) ? obj : obj;
  const keys = Array.isArray(target) ? target.map((_, i) => i) : Object.keys(target);
  for (const k of keys) {
    if (typeof target[k] === 'string') target[k] = stripOne(target[k]);
    else walkStripTime(target[k]);
  }
}

function hasUnresolvedTemplate(s) {
  return typeof s === 'string' && /\{\{[^{}]+\}\}/.test(s);
}

function cleanAirtableFields(obj) {
  if (!obj || typeof obj !== 'object' || !obj.fields || typeof obj.fields !== 'object') return obj;
  const cleaned = {};
  const dropped = [];
  for (const [k, v] of Object.entries(obj.fields)) {
    if (v === '' || v === null || v === undefined) { dropped.push(k); continue; }
    if (hasUnresolvedTemplate(v)) { dropped.push(k); continue; }
    cleaned[k] = v;
  }
  obj.fields = cleaned;
  obj._droppedFields = dropped;
  return obj;
}

function resolveAirtableBody(bodyTemplate, steps, secrets) {
  let parsed;
  try { parsed = JSON.parse(bodyTemplate); }
  catch {
    const resolved = resolveTemplate(bodyTemplate, steps, secrets);
    try {
      const obj = JSON.parse(resolved);
      walkNormalize(obj);
      if (String(secrets.AIRTABLE_KEEP_TIME || '').toLowerCase() !== 'true') walkStripTime(obj);
      cleanAirtableFields(obj);
      const dropped = obj._droppedFields || [];
      delete obj._droppedFields;
      return { body: JSON.stringify(obj), droppedFields: dropped };
    } catch {
      return { body: resolved, droppedFields: [] };
    }
  }
  const resolved = walkResolveInJSON(parsed, steps, secrets);
  walkNormalize(resolved);
  if (String(secrets.AIRTABLE_KEEP_TIME || '').toLowerCase() !== 'true') walkStripTime(resolved);
  cleanAirtableFields(resolved);
  const dropped = resolved._droppedFields || [];
  delete resolved._droppedFields;
  return { body: JSON.stringify(resolved), droppedFields: dropped };
}

// Filter expression — uses a sandboxed Function. Server-side, this still runs
// with whatever permissions the function has, but the expression has access only
// to (input, steps, $$ref). We trust authored flows since they came from the
// authenticated UI; in a multi-tenant deployment you'd swap this for a sandbox.
function evalFilter(expr, input, steps, secrets, log) {
  try {
    const $$ref = refResolver(steps, secrets);
    // eslint-disable-next-line no-new-func
    const fn = new Function('input', 'steps', '$$ref', `return (${expr});`);
    return !!fn(input, steps, $$ref);
  } catch (err) {
    log('warn', `Filter eval error: ${err.message}`);
    return false;
  }
}

function buildFullUrl(baseUrl, params, steps, secrets) {
  const resolved = resolveTemplate(baseUrl, steps, secrets);
  const active = (params || []).filter(p => p.k);
  if (active.length === 0) return resolved;
  const qs = active.map(p => {
    const k = resolveTemplate(p.k, steps, secrets);
    const v = resolveTemplate(p.v, steps, secrets);
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join('&');
  return resolved + (resolved.includes('?') ? '&' : '?') + qs;
}

// ============================================================
//   Per-run iterator/aggregator helpers
// ============================================================

function resolveIteratorSource(node, steps, secrets) {
  const raw = node.config.source;
  const src = resolveTemplate(raw, steps, secrets);
  let items;
  if (Array.isArray(src)) items = src;
  else if (typeof src === 'string') {
    try { items = JSON.parse(src); } catch { items = [src]; }
  } else if (src == null) items = [];
  else items = [src];
  if (!Array.isArray(items)) items = [items];
  return items;
}

function findLoopForAggregator(aggNode, ctx) {
  const feederId = aggNode.config?.feederId ?? aggNode._make?.parameters?.feeder ?? null;
  let cur = ctx;
  while (cur) {
    if (cur.iteration) {
      if (feederId != null) {
        if (cur.iteration.feederMakeId === feederId) return cur.iteration;
      } else return cur.iteration;
    }
    cur = cur.parent;
  }
  return null;
}

function finalizeAggregator(aggNode, values) {
  if (aggNode._make?.module === 'util:TextAggregator') {
    const sep = aggNode.config?.separator ?? ', ';
    return { text: values.filter(v => v !== undefined && v !== null && v !== '').join(sep) };
  }
  if (aggNode._make?.module === 'util:NumericAggregator') {
    return { value: values.reduce((a, b) => a + (Number(b) || 0), 0) };
  }
  switch (aggNode.config.mode) {
    case 'count': return values.length;
    case 'sum':   return values.reduce((a, b) => a + (Number(b) || 0), 0);
    case 'text': {
      const sep = aggNode.config?.separator ?? ', ';
      return { text: values.filter(v => v !== undefined && v !== null && v !== '').join(sep) };
    }
    default: return values;
  }
}

// ============================================================
//   The runner itself
// ============================================================

const DEFAULT_MAX_TOTAL_ITERATIONS = 100_000;

class RunContext {
  constructor({ secrets, logger, abortSignal }) {
    this.secrets = secrets || {};
    this.logger = logger;
    this.abortSignal = abortSignal;
    this.steps = {};
    this.totalIterations = 0;
    this.airtableSchemaCache = new Map();
    // Allow flows that legitimately need huge fan-outs (e.g. paginated lists,
    // routers with many branches) to raise the cap via the Vault. Anything
    // ≤ 0 disables the cap entirely.
    const fromSecret = Number(this.secrets.MAX_ITERATIONS);
    this.maxIterations = Number.isFinite(fromSecret) && fromSecret !== 0
      ? fromSecret
      : DEFAULT_MAX_TOTAL_ITERATIONS;
  }
  log(tag, msg, payload) { this.logger(tag, msg, payload); }
  checkAbort() {
    if (this.abortSignal?.aborted) throw new Error('STOPPED');
  }
}

async function fetchAirtableSchema(ctx, baseId, tableId, authHeader) {
  const cacheKey = `${baseId}/${tableId}`;
  if (ctx.airtableSchemaCache.has(cacheKey)) return ctx.airtableSchemaCache.get(cacheKey);
  try {
    const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const tbl = (data.tables || []).find(t => t.id === tableId);
    if (!tbl) return null;
    const fieldById = {}, fieldByName = {};
    for (const f of tbl.fields) { fieldById[f.id] = f.name; fieldByName[f.name] = f.id; }
    const schema = { fieldById, fieldByName };
    ctx.airtableSchemaCache.set(cacheKey, schema);
    return schema;
  } catch { return null; }
}

async function expandFieldKeys(ctx, fieldsObj, url, headers) {
  if (!fieldsObj || typeof fieldsObj !== 'object') return fieldsObj;
  const m = url.match(/\/v0\/(app[A-Za-z0-9]+)\/(tbl[A-Za-z0-9]+)/);
  if (!m) return fieldsObj;
  const [, baseId, tableId] = m;
  const pat = headers['Authorization'] || headers['authorization'];
  if (!pat) return fieldsObj;
  const schema = await fetchAirtableSchema(ctx, baseId, tableId, pat);
  if (!schema) return fieldsObj;
  const out = { ...fieldsObj };
  for (const [k, v] of Object.entries(fieldsObj)) {
    if (/^fld[A-Za-z0-9]{14}$/.test(k) && schema.fieldById[k]) out[schema.fieldById[k]] = v;
    else if (schema.fieldByName[k]) out[schema.fieldByName[k]] = v;
  }
  return out;
}

async function execNode(ctx, node, prev) {
  const { steps, secrets } = ctx;
  switch (node.type) {
    case 'set': {
      let v = node.config.value;
      v = resolveTemplate(v, steps, secrets);
      if (!node._wrapByName) {
        try { v = JSON.parse(v); } catch {}
      }
      v = deepResolveTemplates(v, steps, secrets);
      const out = node._wrapByName ? { [node.config.name]: v } : v;
      ctx.log('ok', `#${node._stepNum}: set ${node.config.name}`, v);
      return out;
    }

    case 'http': {
      let fullUrl = buildFullUrl(node.config.url, node.config.params || [], steps, secrets);
      const headers = {};
      (node.config.headers || []).forEach(h => {
        if (h.k) headers[resolveTemplate(h.k, steps, secrets)] = resolveTemplate(h.v, steps, secrets);
      });
      const init = { method: node.config.method, headers };
      const isAirtable = /\bapi\.airtable\.com\b/.test(fullUrl);
      let droppedFields = [];

      if (['POST', 'PUT', 'PATCH'].includes(node.config.method) && node.config.body) {
        if (isAirtable) {
          const result = resolveAirtableBody(node.config.body, steps, secrets);
          init.body = result.body;
          droppedFields = result.droppedFields;

          // If body uses field IDs, translate to names via schema (matches Make connector)
          try {
            const parsed = JSON.parse(init.body);
            const fieldKeys = parsed?.fields ? Object.keys(parsed.fields) : [];
            const allIds = fieldKeys.length && fieldKeys.every(k => /^fld[A-Za-z0-9]{14}$/.test(k));
            if (allIds) {
              const m = fullUrl.match(/\/v0\/(app[A-Za-z0-9]+)\/(tbl[A-Za-z0-9]+)/);
              if (m) {
                const [, baseId, tableId] = m;
                const schema = await fetchAirtableSchema(ctx, baseId, tableId, headers['Authorization'] || headers['authorization']);
                if (schema) {
                  const renamed = {};
                  for (const [k, v] of Object.entries(parsed.fields)) {
                    renamed[schema.fieldById[k] || k] = v;
                  }
                  parsed.fields = renamed;
                  init.body = JSON.stringify(parsed);
                } else if (!/[?&]returnFieldsByFieldId=/.test(fullUrl)) {
                  fullUrl += (fullUrl.includes('?') ? '&' : '?') + 'returnFieldsByFieldId=true';
                }
              }
            }
          } catch {}
        } else {
          init.body = resolveTemplate(node.config.body, steps, secrets);
        }
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      }

      ctx.log('info', `#${node._stepNum}: ${node.config.method} ${fullUrl}`);
      if (droppedFields.length) {
        ctx.log('warn', `#${node._stepNum}: dropped ${droppedFields.length} empty/unresolved field(s): ${droppedFields.join(', ')}`);
      }

      let res;
      try { res = await fetch(fullUrl, init); }
      catch (netErr) {
        ctx.log('warn', `#${node._stepNum}: network error (${netErr.message}), retrying in 1s…`);
        await new Promise(r => setTimeout(r, 1000));
        res = await fetch(fullUrl, init);
      }

      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json() : await res.text();
      const result = { status: res.status, ok: res.ok, data };
      ctx.log(res.ok ? 'ok' : 'err', `#${node._stepNum}: ← ${res.status}`, data);

      if (isAirtable && res.ok && data && Array.isArray(data.records) && data.records.length > 0) {
        const first = data.records[0];
        const flatFields = await expandFieldKeys(ctx, first.fields || {}, fullUrl, headers);
        Object.assign(result, first, { id: first.id, ...flatFields });
      }
      if (isAirtable && res.ok && data && data.id && data.fields) {
        const flatFields = await expandFieldKeys(ctx, data.fields, fullUrl, headers);
        Object.assign(result, { id: data.id, ...flatFields });
      }
      if (!res.ok) {
        const snippet = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
        throw new Error(`HTTP ${res.status}: ${snippet}`);
      }
      return result;
    }

    case 'filter': {
      const ok = evalFilter(node.config.expression, prev, steps, secrets, ctx.log.bind(ctx));
      ctx.log(ok ? 'ok' : 'warn', `#${node._stepNum}: filter → ${ok ? 'PASS' : 'STOP'}`);
      if (!ok) throw new Error('Filter halted execution');
      return { passed: true, input: prev };
    }

    case 'router': return prev;

    case 'sleep': {
      const ms = Number(node.config.ms) || 0;
      ctx.log('info', `#${node._stepNum}: sleep ${ms}ms`);
      await new Promise(r => setTimeout(r, ms));
      return { waited: ms };
    }

    case 'iterator': {
      // Single-step path (when iterator is encountered without runChain wrapping it,
      // e.g. inside a router branch where it isn't expanded). Same fallback as the UI.
      const items = resolveIteratorSource(node, steps, secrets);
      return items[0] ?? null;
    }

    case 'aggregator': {
      let out;
      if (node._make?.module === 'util:TextAggregator') {
        const sep = node.config?.separator ?? ', ';
        const value = node.config?.value ? resolveTemplate(node.config.value, steps, secrets) : prev;
        out = { text: String(value ?? '') };
      } else if (node.config.mode === 'count') out = 1;
      else if (node.config.mode === 'sum')     out = Number(prev) || 0;
      else out = [prev];
      return out;
    }

    case 'unknown':
    default: {
      ctx.log('warn', `#${node._stepNum}: unknown node type "${node.type}" — skipped`);
      return prev;
    }
  }
}

async function runChain(ctx, nodes, inputForFirst, ctxStack = null) {
  let prev = inputForFirst;
  for (let i = 0; i < nodes.length; i++) {
    ctx.checkAbort();
    const node = nodes[i];
    const num = node._stepNum;

    if (node.nodeFilter) {
      const passed = evalFilter(node.nodeFilter.expression, prev, ctx.steps, ctx.secrets, ctx.log.bind(ctx));
      if (!passed) {
        ctx.log('warn', `#${num} ${node.label}: inbound filter blocked`);
        return prev;
      }
    }

    // AGGREGATOR inside an iteration — accumulate per-iteration values, finalize on last
    if (node.type === 'aggregator') {
      const loop = findLoopForAggregator(node, ctxStack);
      if (loop) {
        if (!loop.accumulators.has(node.id)) loop.accumulators.set(node.id, []);
        const value = node.config?.value
          ? resolveTemplate(node.config.value, ctx.steps, ctx.secrets)
          : prev;
        loop.accumulators.get(node.id).push(value);

        const isLast = loop.current >= loop.total - 1;
        if (!isLast) return prev;

        const values = loop.accumulators.get(node.id);
        const out = finalizeAggregator(node, values);
        ctx.steps[num] = out;
        ctx.log('ok', `#${num} ${node.label}: aggregated ${values.length} values`);
        prev = out;
        continue;
      }
      // No matching loop — fall through to normal exec (single-shot aggregator)
    }

    // ITERATOR — run the rest of the chain N times with each item as steps[num]
    if (node.type === 'iterator') {
      const items = resolveIteratorSource(node, ctx.steps, ctx.secrets);
      const maxIter = Number(node.config.maxIter) || 100;
      const count = Math.min(items.length, maxIter);
      if (items.length > maxIter) {
        ctx.log('warn', `#${num}: capped at ${maxIter} iterations (source had ${items.length})`);
      }
      ctx.log('info', `#${num} ${node.label}: iterating ${count} items`);

      const loopFrame = {
        feederMakeId: node._make?.id ?? null,
        current: 0,
        total: count,
        accumulators: new Map(),
      };
      const remaining = nodes.slice(i + 1);

      for (let j = 0; j < count; j++) {
        ctx.checkAbort();
        if (ctx.maxIterations > 0 && ctx.totalIterations++ > ctx.maxIterations) {
          ctx.log('err',
            `Hit global iteration cap (${ctx.maxIterations}). Stopping. ` +
            `Raise it by setting MAX_ITERATIONS in the Vault (use -1 to disable).`);
          throw new Error('Global iteration cap exceeded');
        }
        loopFrame.current = j;
        const item = items[j];
        // Inside the loop, steps[num] resolves to the current item (Make semantics).
        // We mutate ctx.steps and restore after — promoting accumulator outputs that
        // were written during the last iteration so post-iterator nodes see them.
        const beforeIter = ctx.steps[num];
        ctx.steps[num] = item;
        const isLast = j === count - 1;
        ctx.log('info', `  [${j + 1}/${count}] iteration`);
        try {
          await runChain(ctx, remaining, item, { iteration: loopFrame, parent: ctxStack });
        } catch (err) {
          if (err.message === 'STOPPED') throw err;
          ctx.log('warn', `    iter ${j + 1}: ${err.message}`);
        }
        if (!isLast) ctx.steps[num] = beforeIter; // restore between iterations
      }
      return prev;
    }

    // Normal node execution
    let out;
    try { out = await execNode(ctx, node, prev); }
    catch (err) {
      ctx.log('err', `#${num} ${node.label}: ${err.message}`);
      throw err;
    }
    ctx.steps[num] = out;
    prev = out;

    // Routers: run each branch from the router's output
    if (node.type === 'router' && node.branches) {
      ctx.log('info', `#${num}: router → ${node.branches.length} routes`);
      for (let k = 0; k < node.branches.length; k++) {
        ctx.log('info', `  ↳ Route ${k + 1}`);
        try { await runChain(ctx, node.branches[k], prev, ctxStack); }
        catch (err) {
          if (err.message === 'STOPPED') throw err;
          ctx.log('err', `  ↳ Route ${k + 1}: ${err.message}`);
        }
      }
    }
  }
  return prev;
}

// Number nodes the same way the UI does: a depth-first walk that assigns
// _stepNum starting at 1. We do this server-side so saved flows that came
// from the editor without numbers also run correctly.
function numberNodes(nodes, counter = { n: 1 }) {
  for (const node of nodes) {
    if (typeof node._stepNum !== 'number') node._stepNum = counter.n++;
    else counter.n = Math.max(counter.n, node._stepNum + 1);
    if (node.branches) for (const b of node.branches) numberNodes(b, counter);
  }
}

/**
 * Run a flow's workflow. Returns a run record:
 *   { status: 'ok'|'err'|'stopped', startedAt, finishedAt, logs, steps, error? }
 *
 * @param {Object}   flow                        Flow definition with .workflow
 * @param {Object}   options
 * @param {Object}   options.secrets             Vault: { KEY: value }
 * @param {*}        [options.initialInput]      Input passed to the first node
 *                                                 (used by webhook triggers)
 * @param {AbortSignal} [options.abortSignal]    Optional cancellation signal
 */
export async function runFlow(flow, { secrets = {}, initialInput = null, abortSignal = null } = {}) {
  const startedAt = Date.now();
  const logs = [];
  const logger = (tag, msg, payload) => {
    const entry = { ts: Date.now(), tag, msg };
    if (payload !== undefined) {
      // Cap payload size so a chatty HTTP response doesn't bloat the run record.
      try {
        const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
        entry.payload = s.length > 4000 ? s.slice(0, 4000) + '… (truncated)' : payload;
      } catch { entry.payload = String(payload); }
    }
    logs.push(entry);
  };

  const workflow = JSON.parse(JSON.stringify(flow.workflow || []));
  numberNodes(workflow);

  const ctx = new RunContext({ secrets, logger, abortSignal });

  ctx.log('info', `── Run: ${flow.name || flow.id} ──`);
  try {
    await runChain(ctx, workflow, initialInput);
    ctx.log('info', '── Run complete ──');
    return {
      status: 'ok',
      startedAt, finishedAt: Date.now(),
      logs, steps: ctx.steps,
    };
  } catch (err) {
    if (err.message === 'STOPPED') {
      ctx.log('warn', '── Run stopped ──');
      return { status: 'stopped', startedAt, finishedAt: Date.now(), logs, steps: ctx.steps };
    }
    ctx.log('err', `Run aborted: ${err.message}`);
    return {
      status: 'err',
      startedAt, finishedAt: Date.now(),
      logs, steps: ctx.steps, error: err.message,
    };
  }
}
