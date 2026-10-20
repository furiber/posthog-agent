# Analytics Audit Agent: overview, what is left, and all remaining specs in one place

**Date:** 2026-10-21 · **Status:** DRAFT, awaiting approval (no code written for anything in sections 3 to 9)
**Branch:** `docs/challenge-assessment` (7 commits ahead of `feat/analytics-audit-agent`, nothing pushed, no PR yet)
**Supersedes:** the piecemeal specs dated 2026-10-20 for planning purposes; those stay as the record of what was built.

## TL;DR

- **Where we are:** the agent crawls a site, finds PostHog/GA4/GTM (including PostHog behind a proxy), explains why a tag sends nothing (CSP, failed requests), and writes only recommendations the server can back with evidence. 97/97 tests pass, typecheck is clean, and live runs on nobodycame.app and coffeerouletteapp.com are honest.
- **What is still wrong:** the events table has duplicate/split rows (F16), the CSP finding overclaims site-wide from one page (F15), and the validation loop (Jev) never converges and now mostly argues with deterministic data (F1).
- **What is missing:** a real preview UI (today it is a placeholder page), a Claude Agent SDK version for the TAI Labs challenge (due Fri 23 Oct; today is Day 3), the nobodycame.app CSP fix (F9, one line), a README that matches the code, a lint script, and checks on three site types we have not run live.
- **Recommended order:** challenge port first (hard deadline), the three accuracy fixes (A, B) next because the port reuses them, then UI, hygiene and rollout.
- **Server:** running at http://localhost:5174 (5173 was taken).

## 1. What we have

### 1.1 The pipeline (how a run works)

```
POST /run {url, pageBudget}
   │
   ▼
Crawl (model-driven, tools only)         browser = Playwright / Cloudflare Browser Rendering
   load_page → inspect_dom → interact(consent, CTA, form) → next page
   server captures: tag scripts, beacons, DOM, console CSP errors, failed requests, interaction probes
   │
   ▼  evidence store (append-only, IDs E000001…, source = capture)
   │
   ├─ nothing detected? → "No analytics detected" report, no model calls (F7)
   │
   ▼
Synthesize (server-built tables)          tags, events, gaps (+ remedy templates)
   model step: names for tracking-plan rows only; each row needs a gap/event basis
   │
   ▼
Validate: reviewer critiques → Jev grades → revise   (3 rounds max)   ← F1: never converges
   │
   ▼
Final gate → markdown + JSON report, streamed over SSE, saved at /runs/:id/report.md
```

### 1.2 What the agent can do today

| Capability | Status | Verified how |
|---|---|---|
| Detect GA4, gtag, GTM tags and beacons | Works | live: coffeerouletteapp.com |
| Detect PostHog incl. proxy host and renamed loader (`/ph.js`, `t.nobodycame.app`) | Works | live: nobodycame.app; 8 unit tests |
| Say "tag present but no events" and why (CSP block, failed request) | Works (overclaims site-wide, F15) | live: nobodycame.app |
| Honest empty report when no analytics found | Built | unit tests only, not run live |
| Recommendations written by server from findings | Works | live on both sites |
| Tracking-plan rows: basis required, evidence server-assigned, `add` needs proof the interaction exists | Works | live + 20 unit tests |
| Duplicate-beacon finding | Built | unit tests; saw it fire on coffeerouletteapp.com |
| Langfuse tracing, SSE stream, persisted reports | Existing | not re-checked this week |
| Deployed Worker | Existing per git log ("validated in production") | not re-checked; production still runs older code |

### 1.3 What we built over 20-21 Oct (all committed on `docs/challenge-assessment`)

| Commit | What |
|---|---|
| `ef35940`, `dcda1a2`, `fb639cc`, `57d6836` | Four specs with dated findings logs |
| `252c4f3` | F6 proxy-aware PostHog detection, F7 empty-state report |
| `ffc1d9d` | F10 CSP/failed-request diagnostics and "tag present but silent" finding |
| `a30f870` | F11-F14 server-owned recommendations, evidence-backed plan rows, no model-authored evidence |

### 1.4 Tests and tooling

- 97 tests in 10 files (`npm test`), `npm run typecheck` clean.
- No `lint` script (the session hook flagged it). No CI. No pull request has been opened, so the code-review hook has not run.

### 1.5 The preview UI today

`GET /` is a placeholder: a URL box, a page-budget box and a raw SSE log (`src/statusPage.ts`, 95 lines). No report rendering, no run history, no evidence view.

## 2. Findings scoreboard

| ID | Finding | Status |
|---|---|---|
| F1 | Validation loop never converges; now critiques deterministic tables it cannot edit | Open (section 4, B) |
| F2, F8 | Unsupported recommendations on sites with tags | Fixed via F11-F14 |
| F3 | "No consent" claim contradicted by Consent Mode params on the wire | Open (section 4, A3) |
| F4, F5 | PostHog evidence missing; stack differs from challenge | F4 fixed (F6); F5 addressed by section 5 |
| F6 | PostHog missed behind proxy / renamed loader | Fixed |
| F7 | Empty detection invents advice | Fixed (unit tests only) |
| F9 | nobodycame.app CSP blocks its own PostHog script | Open, site fix (section 8) |
| F10 | Cannot explain "tag but no beacons" | Fixed |
| F11-F14 | Model-written claims, model-authored evidence, no probe evidence, existence-only gate | Fixed |
| F15 | CSP finding claims site-wide from per-page observation | Open (section 4, A1) |
| F16 | Duplicate / split event rows | Open (section 4, A2) |
| F17 | README and sample report describe the old pipeline | Open (section 9) |
| F18 | No lint script, no CI, no PR/code review yet | Open (section 9) |
| F19 | Live coverage gaps: posthog.com, GTM-only site, zero-analytics site | Open (section 9) |

Full dated history stays in the four 2026-10-20 spec files.

## 3. What is left, at a glance

| # | Workstream | Why | Size | Depends on |
|---|---|---|---|---|
| A | Accuracy of the deterministic tables (F15, F16, F3) | Reviewer and readers see wrong rows | M | none |
| B | Rework the validation loop (F1) | Wasted cost, never converges, ships "contested" flags | S-M | A |
| C | Preview UI | You asked for a better preview; today it is a log | M | none (better after A) |
| D | Claude Agent SDK TypeScript port (TAI Labs challenge) | Hard deadline Fri 23 Oct | M-L | reuses A's pure modules |
| E | nobodycame.app CSP fix (F9) | PostHog is silent on your own site | S | none |
| F | Hygiene: README, lint, CI, sample report, live coverage checks, PR | Ship-ready | S-M | A, B |
| G | Rollout: deploy a Cloudflare preview, then production | Production still runs old code | S | A, B, F |

## 4. Specs: A and B (core accuracy)

### A. Accuracy of the deterministic tables

**A1. Per-page CSP findings (F15).**
- Problem: one page's CSP error becomes "no events are sent" for the site. On `/about` the script loaded and a click fired a beacon.
- Spec: keep CSP violations per page. The finding states the scope: "blocked on N of M visited pages: <list>". Severity HIGH only when it affects every page where the tag was seen; MEDIUM and "partially blocked" otherwise. The "no events are sent" sentence appears only if no beacon for that destination fired on any page.
- Investigate first: why a beacon fired on `/about` while the events table stayed empty (config request with zero parsed events, or unclassified). Record whether `/about` has a different CSP header.
- Tests: two pages, one blocked, one not (partial wording); all pages blocked (full wording); fired beacon on one page (no "no events" claim).

**A2. Event table duplicates and splits (F16).**
- Problem: `page_view` can appear twice with the same interaction and destination, and a click that triggers navigation produces a second "click" `page_view` row.
- Spec: group by event name, destination and interaction after normalising the interaction. A reserved load-type auto-event (page_view, `$pageview`, session_start, first_visit) that fires during an interaction step is attributed to `load` with a note "fired after <interaction>", not a new row. Rows for the same key merge their pages and evidence.
- Find the cause of the exact duplicate rows first (key construction in `buildEventRows`, `store.interactionFor`).
- Tests: two identical keys merge; navigation-triggered `$pageview` stays under `load`; a custom `cta_click` fired by a click stays under `click`.

**A3. Consent evidence (F3).**
- Problem: "No consent-mode handling observed" while GA4 beacons carry Consent Mode state params (`gcd`, `npa`, `dma`).
- Spec: parse `gcd`, `npa`, `dma` (and `gcs`) from GA4 collect URLs into beacon evidence. If present, the finding becomes "Consent Mode signals present, no banner observed" with a different remedy; the "no consent" wording is not used.
- Check current Google Consent Mode parameter docs via Context7 before coding.
- Tests: a collect URL with `gcd=` produces consent evidence; the gap text changes; without it the old text stays.

**Acceptance for A:** reruns on both sites show no duplicate rows, a scoped CSP sentence, and zero reviewer critiques about table accuracy. Unit tests for each item above.

### B. Validation loop (F1)

- Problem (measured): 3 rounds, Jev-Correct critiques every round, items shipped "contested". After F11-F14 nearly everything in the report is server-derived, so the reviewer argues with data the revise step cannot change.
- Decision: **scope the loop to what a model still writes.** That is only the tracking-plan rows. Tags, events and gaps are deterministic and are checked by code (A), not by a reviewer.
- Spec:
  1. Skip the whole loop when the plan has no rows (most runs today). No reviewer, no Jev calls.
  2. When rows exist, the reviewer sees only plan rows plus their basis evidence, and may critique only plan targets (`plan:<i>`); other targets are rejected at parse time.
  3. Contested items remain flagged as today.
  4. Add a deterministic "table accuracy" lint pass instead (events table vs evidence: every row's evidence IDs exist, interaction matches, no duplicate keys) that runs in the gate and fails loudly in tests.
- Expected effect: cost per run drops, rounds go to 0 or 1, no shipped "contested" flags caused by the reviewer attacking server data.
- Tests: no-plan run makes zero reviewer calls (fake model); a critique targeting `gaps:0` is rejected; a plan-row critique still flows through Jev and revise.
- Risk: loses an independent check on data accuracy; mitigated by A's lints and tests. Keep the loop code behind a config flag (`maxValidationRounds`) so it can return for other surfaces.

## 5. Spec D: Claude Agent SDK port for the TAI Labs challenge

**Why:** the challenge is the Claude Agent SDK (Python or TypeScript), 19 to 23 Oct. Today is Day 3; Day 5 (ship and show) is Fri 23 Oct. Our agent runs on the Cloudflare Agents SDK with OpenRouter flash models, so it does not qualify as is. Decision on 2026-10-20: slim TypeScript port, keep the Cloudflare agent as the product.

**One sentence (the challenge's own test):** *My agent reads a website and gives me an evidence-cited audit of its analytics setup, and never claims what it cannot prove.*

**Checked in Context7 (2026-10-21, `/websites/code_claude_en_agent-sdk`):**
- `query({ prompt, options })` from `@anthropic-ai/claude-agent-sdk`; options include `allowedTools`, `maxTurns`, `systemPrompt`, `permissionMode`, `mcpServers`, `cwd`, `model`.
- Custom tools: `tool(name, description, zodShape, handler)` and `createSdkMcpServer({ name, version, tools })`; handler returns `{ content: [{ type: "text", text }] }`. Tool names are exposed as `mcp__<server>__<tool>` and must be allow-listed in `allowedTools`.
- Cost guard: `maxBudgetUsd` (0 is rejected). Hitting it ends with result subtype `error_max_budget_usd`; a single-shot `query()` yields that result then throws, so wrap the loop in try/catch. Read cost from `total_cost_usd` on any result message.
- TypeScript `env` replaces the subprocess environment: spread `process.env` if you pass it.
- Re-check the exact model id and package version at build time; both change.

**Design (maps to challenge days):**

| Day | Deliverable |
|---|---|
| 3 (today) | Project skeleton, `check_setup` equivalent, first agent run with `maxBudgetUsd`; reuse of pure modules |
| 4 | Break it and add guardrails: budget cap, `allowedTools` allow-list, claim lint, the three hard sites (CSP-blocked, no analytics, GTM-only) as tests |
| 5 | README, 90-second Loom, post in the challenge thread |

**Architecture:**
- Folder `challenge/` in this repo (or a sibling repo; see open decision 3), Node 24, local Playwright only (no Cloudflare binding).
- The Claude agent loop decides what to inspect and which interactions to try. It has only the in-process MCP tools: `load_page`, `inspect_dom`, `fire_interaction`, `finish`. No shell, no file tools (`allowedTools` lists only `mcp__audit__*`).
- Tools return facts and write **evidence** exactly as today; the model cannot write evidence.
- A pure `buildReport(evidence)` produces tags, events, gaps and templated recommendations; the model proposes tracking-plan names only, validated by `validatePlan`.
- **Reused unchanged (pure, already tested):** `src/browser/capture.ts`, `src/pipeline/recommend.ts`, gap builders in `synthesize.ts`, `empty.ts`, `render.ts`. To share them, move these into `packages/core` or import by relative path; decision at build time.
- CLI: `npx tsx challenge/audit.ts https://example.com --budget 0.5` prints the markdown report and cost.
- Needs `ANTHROPIC_API_KEY` with API credit (a Claude subscription does not cover the API, per the challenge README).

**Acceptance:** runs end to end on nobodycame.app, coffeerouletteapp.com and a zero-analytics site; each run stays under the budget; the report passes the same claim checks; a budget-exceeded run ends cleanly with a partial report.

**Risks:** time (three days, one of them spent); cost surprises (mitigated by `maxBudgetUsd` and a per-page step cap); drift between the two codebases (mitigated by sharing pure modules).

## 6. Spec C: Preview UI

**Goal:** open one page, enter a URL, watch the audit, read the report, click any evidence ID to see the proof.

**Scope (one page, no framework beyond what Workers can serve inline or via the existing Vite setup):**
1. **Run panel:** URL, page budget, Run. Live phase strip (crawl, synthesize, validate, gate) driven by SSE `phase` events, with page count and evidence count.
2. **Report view:** render the markdown report from the `report` SSE event or `/runs/:id/report.md`; evidence IDs become links that open a side drawer.
3. **Evidence drawer:** the evidence item (kind, page, payload, source) from a new `GET /runs/:id/evidence/:eid`.
4. **Run history:** last 20 runs for this instance with site, time, outcome (`audited` / `no_analytics_detected` / partial), from a new `GET /runs`. Needs a small index in storage (the Durable Object is per run today).
5. **Findings summary header:** counts of tags, events, gaps by severity.
- Design: invoke the `design-taste-frontend` skill before markup (user rule). Dense product UI, so the skill may be skipped for data tables; decide at build time.
- Out of scope: auth, multi-user, editing reports, PDF export.
- Tests: unit tests for the new endpoints; manual preview check with screenshots saved under `docs/screenshots/2026-10-21-preview/`.
- Risk: the run-history index changes storage layout; keep it additive.

## 7. (reserved) Cross-cutting rules for every workstream

- Spec before build, tests first, dated findings, `CHANGELOG.md` entry in the same commit for user-visible changes, work on this branch or a worktree off it, Context7 before touching a third-party API, screenshots committed under `docs/screenshots/<date>-<topic>/`.

## 8. Spec E: nobodycame.app CSP fix (F9)

- File: `landing/_headers` in the cro-audit-agent-apps repo. The copy I found is in the `glossary` worktree; apply it in the repo or branch you deploy from.
- Current line (line 11): `script-src 'self' 'unsafe-inline' https://eu.i.posthog.com` and `connect-src 'self' https://eu.i.posthog.com`.
- Change: add `https://t.nobodycame.app` to `script-src` and `connect-src`. Add it to `img-src` only if PostHog beacons fall back to image requests (check in the console after the change).
- Why: the page loads `https://t.nobodycame.app/static/array.js` and sends events to `t.nobodycame.app`, but the CSP only allows `eu.i.posthog.com`, so the script is blocked and no events are sent.
- Verify: reload the site, console shows no CSP error for `t.nobodycame.app`; a rerun of this agent shows `$pageview` and no "blocked" finding (this is also the positive-path test for the whole detection chain).
- Needs your go-ahead since it is a different repo and a production site.

## 9. Specs F and G: hygiene and rollout

**F. Hygiene**
1. **README (F17):** rewrite the "report", "design" and "HTTP API" sections to match: server-owned claims, probes, `remedy`, `outcome`, new gaps, no model-authored evidence, no recommendations from the model. Refresh `docs/sample-report.md` from a current run (include a nobodycame.app sample).
2. **Lint (F18):** add a `lint` script. Options: ESLint with typescript-eslint, or Biome (one dependency, fast). Recommend Biome; confirm in open decisions. Fix findings that matter; no mass reformatting.
3. **CI:** a GitHub Actions workflow running `npm ci`, `typecheck`, `lint`, `test`. Check current action versions and Node 24 setup via Context7 before writing it.
4. **Live coverage (F19):** run and record three more sites: posthog.com (PostHog positive, browser-rendered), a GTM-only site, and a site with zero analytics (the F7 empty path has only unit tests). Save outputs under `docs/` with dates.
5. **Code review and PR:** run `/code-review` on the branch, fix correctness findings, open a PR against `feat/analytics-audit-agent` (the hook reminds before `gh pr create`). Nothing is pushed yet; pushing and the PR need your OK.

**G. Rollout**
1. `cf previews deploy` for a preview URL; run the same two sites against it (Browser Rendering may surface console events differently from local Chrome, unverified).
2. Compare preview output with local output.
3. Production deploy only after F is done and you approve; secrets persist per Worker (`cf deploy --secrets-file .env` only when keys change).

## 10. Recommended sequence

| Order | Work | Why now |
|---|---|---|
| 1 | D (port): Day 3 skeleton and first run | Hard deadline; the port reuses what exists |
| 2 | A1-A3 | The port needs correct tables; tests are pure and quick |
| 3 | B | Cuts cost; removes the confusing "contested" flags before the demo |
| 4 | E | Your site's PostHog starts working; gives the positive-path check |
| 5 | C | The preview you asked for, built on correct data |
| 6 | F then G | Ship-ready |

If time is short before Fri 23 Oct: D, A1, A2, B, E are the demo-critical set. C, F and G follow.

## 11. Open decisions (answer once, I build against them)

1. **Order:** challenge port first (recommended), or UI/accuracy first?
2. **Port location:** a `challenge/` folder in this repo sharing the pure modules (recommended), or a separate repo?
3. **Lint tool:** Biome (recommended) or ESLint?
4. **UI scope:** the five items in section 6, or just the report view plus evidence drawer for now?
5. **Site fix E:** may I prepare the one-line CSP change as a patch in the cro-audit-agent-apps repo for you to review?

## Findings log (additions on 2026-10-21)

| ID | Finding | Date found | Status | Date fixed |
|---|---|---|---|---|
| F17 | README and sample report describe the old pipeline | 2026-10-21 | Open | n/a |
| F18 | No lint script, no CI, no PR or code review yet | 2026-10-21 | Open | n/a |
| F19 | Live coverage missing: posthog.com, GTM-only, zero-analytics | 2026-10-21 | Open | n/a |
