# Analytics Audit Agent

Crawls a website and produces, in one run, a complete current-state picture of its analytics instrumentation (PostHog and/or GA4 / GTM / gtag), validates that picture adversarially, and ships a markdown report streamed over server-sent events.

Built on **Cloudflare Workers** + the **Cloudflare Agents SDK** (`agents` npm package — the agent lives in a Durable Object, and the Agents SDK runs the crawler's tool-stepping loop). Browsing runs through the **Cloudflare Browser Rendering binding** (`@cloudflare/playwright`) — in local dev the same package runs a local Chrome against the same tool interface.

## The report (one run, five sections + appendices)

1. **Tag inventory** — every analytics tag/snippet found, where it's injected, and which destination it feeds.
2. **Events & interactions** — a naming-conventions table of all events sent through and the interactions when they occur (beacon-level: pageview auto-events, custom events, the click/form/consent interaction that fired each), with properties and per-event destinations, every row citing evidence IDs.
3. **Naming conventions** — the dominant convention already present on the site; if none is discernible, the default `object_action` snake_case for events and snake_case for properties, with destination-specific notes for GA4 (terminology-locked). This is the editorial standard the report grades against.
4. **Gaps & misconfigurations** — missing consent-mode handling, double-counting risk when PostHog + GA4 fire independently, pageview-only usage, duplicate/messy names for the same interaction.
5. **Recommendations** — tags to keep/retire, events to add/rename/deprecate, a diffable tracking-plan table of proposed names and properties, and priority ordering.

Appendices: the **Jev validation round log**, contested items (shipped with explicit flags, never silently dropped), and partial-evidence error reports when budgets exhaust.

## Design: assume weak models

Every model call is a weak, cheap flash-tier model (default `deepseek/deepseek-v4.1-flash` for the crawler and synthesizer, `z-ai/glm-5.3-flash` as the adversarial reviewer). The reliability comes from the loop and the Jev adjudication, not model intelligence:

- four roles, two model call sites — the Agents SDK `streamText` tool-stepping loop (crawler) and small one-job JSON chat calls (synthesizer, adversarial reviewer); the Jev adjudicator is a separate grader API call.
- deterministic tools with strict schemas; tables are assembled from evidence server-side, never enumerated by the model.
- **no claim exists without an evidence ID** — every beacon/snippet captured on the wire gets one (`E000001…`), append-only in Durable Object storage.
- validation loop: draft → adversarial critique (fresh context) → **Jev grades each critique Correct / Partially Correct / Incorrect** → only Correct critiques propagate → revise. Repeat until a round produces zero Jev-Correct critiques, or 3 rounds max.
- agent-loop attempts are **tool retries** (4; 8 for pages that fail to render or are marked complex — SPA, heavy client routing), budget 40 successful tool steps per page, and a wall-clock cap. Budgets exhaust into a partial-evidence error report — never fabrication.

## Setup

```sh
npm install
```

Copy `.env.example` to `.env` and fill in:

```sh
# OpenRouter key (model access): https://openrouter.ai/settings/keys
OPENROUTER_API_KEY=
# TypeSafe Jev grader key (validation loop)
TYPESAFE_API_KEY=
```

`.env` is git-ignored. To provide the keys to a deployed Worker instead, upload them with the version:

```sh
cf deploy --secrets-file .env
```

(`cf` is the Cloudflare CLI — `npm i -D cf`. Sign in first with `cf auth login`.)

## Run budgets (cloudflare.config.ts)

`AGENT_CONFIG` in `cloudflare.config.ts` controls a run: `pageBudgetDefault` (50), `pageBudgetMax` (200, hard cap), `maxToolStepsPerPage` (40), `toolAttemptLimit` (4), `complexToolAttemptLimit` (8), `wallClockCapMs` (600 000), `maxValidationRounds` (3), `crawlParallelism` (2 — tool-level concurrency of browser contexts, never separate agent sessions). Model ids and endpoint URLs (`OPENROUTER_BASE_URL`, `CRAWLER_MODEL`, `SYNTHESIZER_MODEL`, `REVIEWER_MODEL`, `JEV_API_URL`, `JEV_MODEL`) are text bindings there too.

## Local development

```sh
npm run dev        # cf dev → http://localhost:5173
```

- The BROWSER binding runs a **local Chrome** in dev through `@cloudflare/playwright` (set `X_BROWSER_HEADFUL=true npm run dev` to watch it). Deployed, the same `launch(env.BROWSER)` call drives Cloudflare Browser Rendering.
- `cf dev` reads secrets from `.env` / `.dev.vars`.
- Type checks: `npm run typecheck` (`cf workers types && tsc --noEmit`).
- Unit tests: `npm test` — the Jev request/response contract and the report structure schemas, plus the naming-convention engine and beacon classification.

## Preview validation with the cf CLI

1. `cf dev`, then open the status page at `http://localhost:5173/` (placeholder URL-entry UI; a real UI can be added later).
2. Start a run:

```sh
curl -N -X POST http://localhost:5173/run \
  -H "content-type: application/json" \
  -d '{"url":"https://www.posthog.com","pageBudget":3}'
```

   The response is an SSE stream: `run_started`, `phase`, `discovered`, `tool_step` (with attempts/retries), `page`, `interaction`, `evidence`, `crawl_done`, `draft_ready`, `critique`, `jev_verdict`, `round_summary`, `revised`, `gate_notes`, `report` (the full markdown), `done`.
3. Assert the run completes, beacons were captured, and a well-formed report is produced (all five sections present, every event row citing an evidence ID, the naming table passing the convention check).
4. Run it a second time and check stability: same URLs visited, plausible — not inconsistent — event sets, and attempt/retry accounting present in the run log.
5. Fetch a persisted report afterwards: `GET /runs/:runId/report.md` (or `/report` for JSON).

To deploy a preview on real Cloudflare infrastructure:

```sh
cf previews deploy
```

## Deploy

```sh
cf deploy --secrets-file .env
cf deploy          # later deploys (secrets persist per Worker)
```

## HTTP API

| Route | Description |
|---|---|
| `GET /` | placeholder status/entry page (SSE consumer) |
| `GET /health` | liveness |
| `POST /run` | `{ url, pageBudget? }` → SSE stream of the audit |
| `GET /runs/:id/report.md` | persisted markdown report of a run |
| `GET /runs/:id/report` | persisted JSON report of a run |

## Model access

Model calls go through an **OpenAI-compatible endpoint** — OpenRouter by default (`https://openrouter.ai/api/v1`). To route through **Cloudflare AI Gateway** instead, point `OPENROUTER_BASE_URL` in `cloudflare.config.ts` at your gateway's OpenAI-compatible URL and put the gateway credential in `OPENROUTER_API_KEY`. GLM 5.3's reasoning effort is pinned low everywhere (it defaults to max on OpenRouter, which is slow).

The Jev adjudicator calls the TypeSafe systemone choice grader directly (`https://api.typesafe.ai/v1/systemone`, model `jev-latest`) with structured claim+evidence state — a separate grader, never one of the report-writing models.

## Tracing (Langfuse v4)

One Langfuse trace per run, one generation per model call — crawler tool-loop calls (`crawler-loop`), the tracking-plan step (`synth-plan`), each adversarial round (`review-round-N`), and every Jev grade (`jev-<critiqueId>`) — with full input/output, token usage, and cost (OpenRouter `usage.include`; Jev billed at $0.042/M input).

Implementation is **Langfuse v4's OTLP ingest with zero SDK**: spans are built in memory and POSTed once per flush to `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces` with `x-langfuse-ingestion-version: 4` — no OpenTelemetry SDK in the bundle, Workers-native (same pattern as a plain fetch).

To switch tracing on, add your Langfuse keys to `.env` and redeploy:

```sh
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
# LANGFUSE_BASE_URL is preset in cloudflare.config.ts; override for self-hosted instances
cf deploy --secrets-file .env
```

Tracing is off unless both keys are set, and a tracing failure never fails a run (the ingest result surfaces as an SSE `trace` event).
