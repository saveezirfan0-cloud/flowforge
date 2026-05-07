# FlowForge on Vercel

Multi-flow visual workflow builder, deployed as a Vercel app. Build and edit
workflows in the browser, persist them to KV storage, run them on a schedule
(cron), trigger them via webhook, or fire them on demand. Background execution
uses Vercel's `waitUntil` so the HTTP request returns immediately while the
flow keeps running.

```
flowforge-vercel/
├── public/
│   └── index.html              ← the editor UI (single-file, no build step)
├── api/
│   ├── health.js               ← GET /api/health
│   ├── secrets.js              ← GET / PUT /api/secrets
│   ├── cron.js                 ← GET /api/cron (Vercel-triggered)
│   ├── flows/
│   │   ├── index.js            ← GET / POST /api/flows
│   │   ├── [id].js             ← GET / PUT / DELETE /api/flows/:id
│   │   └── [id]/
│   │       ├── run.js          ← POST /api/flows/:id/run
│   │       ├── runs.js         ← GET  /api/flows/:id/runs
│   │       └── rotate-webhook.js
│   ├── runs/[runId].js         ← GET /api/runs/:runId
│   └── webhooks/[id].js        ← ANY /api/webhooks/:webhookToken
├── lib/
│   ├── runner.js               ← server-side flow runtime
│   ├── kv.js                   ← thin Upstash Redis wrapper
│   ├── store.js                ← flow + run CRUD on top of KV
│   ├── util.js                 ← cron parser, ID gen
│   └── api.js                  ← shared HTTP helpers
├── vercel.json                 ← cron schedule + function timeouts
└── package.json
```

## What you get

- **Multiple flows.** Create, rename, duplicate, delete. Switch between them
  in the editor with the **☰ Flows** button. Each flow is a complete workflow
  with its own schedule, webhook URL, and run history.
- **Background execution.** Click **⚡ Run on Server** to fire a flow without
  blocking the browser. The function returns a run ID immediately and the
  flow keeps executing for up to 60 seconds. Logs stream back as you poll.
- **Schedules.** Per-flow scheduling: manual only, every N minutes, or full
  cron expression. Vercel Cron pings `/api/cron` every minute; the handler
  scans all enabled flows and fires whatever is due.
- **Public webhooks.** Each flow gets a unique URL. POST/GET/PUT/DELETE all
  work. The request payload becomes `steps[0]` in the flow, so downstream
  nodes can reference `{{0.email}}`, `{{0.user.id}}`, etc.
- **Run history.** Each run records its trigger, logs, final step values,
  and any error. Last 50 runs per flow are kept.
- **Shared secrets vault.** Stored server-side in KV instead of localStorage,
  so cron'd flows on Vercel can use them too. Reference as `{{KEY}}`.
- **Make.com import/export still works.** Drop a Make blueprint in, you'll
  be prompted to save it as a server flow.

## Deploy

### 1. Push the project to GitHub

```bash
git init && git add . && git commit -m "FlowForge on Vercel"
gh repo create flowforge-vercel --private --source=. --push
```

…or use the GitHub web UI. Either works.

### 2. Import to Vercel

[vercel.com/new](https://vercel.com/new) → import the repo. **Framework
preset:** "Other". No build command, no output directory — Vercel will pick
up `public/` and the `api/` folder automatically.

Click Deploy. The first deploy will succeed but the app will warn about KV
not being configured. That's expected.

### 3. Set up storage

Vercel KV the standalone product was retired in early 2025 — KV is now
provisioned through the **Marketplace** as Upstash Redis. The `@upstash/redis`
package this project uses works with that integration directly.

In your Vercel project: **Storage** tab → **Create Database** → pick
**Upstash for Redis** (or **Upstash** in the Marketplace section). Walk
through the prompts. When it's done, Vercel auto-injects two env vars into
your project:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

(If you're hosting elsewhere or want to BYO, the code also reads
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.)

Redeploy (Vercel does this automatically when env vars change). Refresh the
app — the **☰ Flows** button should now open without the warning banner.

### 4. (Recommended) Lock down the admin API

By default, `/api/flows*`, `/api/secrets`, and the run-trigger endpoints are
**open** — anyone who finds your URL can edit your flows. To require auth:

In the Vercel project's **Settings → Environment Variables**, add:

- `FLOWFORGE_ADMIN_TOKEN` = some long random string

Redeploy. The frontend will prompt you for the token on first load and store
it in `localStorage`. From then on, every request includes
`Authorization: Bearer <token>`. The public webhook endpoints
(`/api/webhooks/<token>`) **do not** require this — their per-flow token is
the auth.

### 5. Cron auth

Vercel automatically attaches `Authorization: Bearer $CRON_SECRET` to scheduled
function calls. The `CRON_SECRET` env var is provisioned by Vercel itself
(visible under Settings → Environment Variables → System Environment Variables).
You don't need to set it — but you should verify it exists if you want to
guarantee that random callers can't hit `/api/cron` and trigger your flows.

If you want to manually trigger the cron sweep (e.g., from a curl or external
scheduler), authenticate with either `CRON_SECRET` or `FLOWFORGE_ADMIN_TOKEN`:

```bash
curl https://<your-app>.vercel.app/api/cron \
  -H "Authorization: Bearer $FLOWFORGE_ADMIN_TOKEN"
```

## Schedule semantics

The cron handler runs every minute (`* * * * *` in `vercel.json`). For each
enabled flow it checks:

| `schedule.type` | Fires when                                                 |
| --------------- | ---------------------------------------------------------- |
| `manual`        | Never. Only manual triggers and webhooks.                  |
| `interval`      | `now - lastRunAt >= intervalMinutes * 60 * 1000`           |
| `cron`          | The 5-field cron expression matches the current UTC minute |

Cron expressions are interpreted in **UTC**, with standard 5-field syntax:
`minute hour day-of-month month day-of-week`. Steps (`*/15`), ranges (`9-17`),
and lists (`0,30`) are supported. Day-of-week uses 0–6 (or 7) with Sunday = 0.

> **Hobby plan caveat:** Vercel's free tier limits cron to **once per day**.
> If you're on Hobby, change the schedule in `vercel.json` to something like
> `0 9 * * *` and only use per-flow `interval` schedules that are ≥ 1440
> minutes, OR upgrade to Pro for `* * * * *`. Alternatively, drive the
> `/api/cron` endpoint from an external scheduler (GitHub Actions on a cron,
> a curl from a beefy machine, [cron-job.org](https://cron-job.org), etc.).

## Background execution model

Vercel functions normally end when the response is sent. To keep flows
running after the HTTP response, the run/webhook/cron handlers wrap the
flow execution in `waitUntil()` from `@vercel/functions`. This works on
both Hobby and Pro tiers, but the function still has a hard `maxDuration`
ceiling (60s by default in `vercel.json`; can be bumped to 300s on Pro).
For flows that take longer than this, split them into smaller pieces and
chain them via webhook.

## Local development

```bash
npm install -g vercel
vercel link
vercel env pull .env.local       # pulls KV_REST_API_* etc.
vercel dev
```

Then open <http://localhost:3000>. Cron won't fire locally (Vercel cron is
production-only), but you can hit `/api/cron` by hand to test the sweep.

## API reference (admin)

All return JSON. All require `Authorization: Bearer <FLOWFORGE_ADMIN_TOKEN>`
when that env var is set.

| Method  | Path                                  | Body / Query                                   |
| ------- | ------------------------------------- | ---------------------------------------------- |
| GET     | `/api/health`                         | — (public)                                     |
| GET     | `/api/flows`                          | List all flows (metadata only)                 |
| POST    | `/api/flows`                          | `{ name, workflow, scenarioMeta, schedule }`   |
| GET     | `/api/flows/:id`                      | Full flow including workflow body              |
| PUT     | `/api/flows/:id`                      | Partial update — any of `name`, `workflow`, `schedule`, `enabled`, `scenarioMeta` |
| DELETE  | `/api/flows/:id`                      | —                                              |
| POST    | `/api/flows/:id/run`                  | `{ input? }` — fires in background, returns run id |
| GET     | `/api/flows/:id/runs?limit=20`        | Run history for this flow                      |
| POST    | `/api/flows/:id/rotate-webhook`       | Generate a new webhook token                   |
| GET     | `/api/runs/:runId`                    | Full run record with logs and steps            |
| GET     | `/api/secrets`                        | Returns key list + masked values               |
| PUT     | `/api/secrets`                        | `{ set: { KEY: value }, delete: ['KEY'] }`     |

## API reference (public)

| Method | Path                          | Notes                                       |
| ------ | ----------------------------- | ------------------------------------------- |
| ANY    | `/api/webhooks/:webhookToken` | Triggers the flow. JSON body or query string becomes `steps[0]`. Returns `{ runId }`. |

## Flow data model

```jsonc
{
  "id": "flow_xxx",
  "name": "Send daily Airtable digest",
  "workflow": [ /* … nodes, see below … */ ],
  "scenarioMeta": { /* optional Make blueprint metadata */ },
  "schedule": {
    "type": "cron",
    "cronExpr": "0 9 * * 1-5"
  },
  "enabled": true,
  "webhookToken": "abc123…",
  "createdAt": 1735689600000,
  "updatedAt": 1735689600000,
  "lastRunAt": null
}
```

Node shapes are unchanged from the original FlowForge editor. See
`lib/runner.js` for the full set of supported types.
