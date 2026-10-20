# 5-day delivery plan: an analytics audit agent you can trust

**Date:** 2026-10-21 · **Status:** DRAFT, awaiting approval (no code written for anything below)
**Replaces for sequencing:** `overview-and-roadmap-2026-10-21.md` (it stays as the detailed workstream specs A to G; this plan re-orders them around a new finding).

## TL;DR

- **The finding that reset the plan:** on https://www.aa.co.nz/membership (the site you ran in the preview) the analytics **do load and do fire**. In a real browser I saw GA4 beacons to `analytics.aa.co.nz/g/collect` (a first-party server-side GTM host), `analytics.google.com/g/collect` and `stats.g.doubleclick.net/g/collect`, with Consent Mode signals (`gcd`, `dma`, `npa`). Our agent only recognises `google-analytics.com`, so it reported "no events observed" and guessed "the library had not finished loading". That guess was wrong. The agent was blind, not the site silent.
- **Root cause is the same lesson as PostHog:** we identify tags by hostname instead of by what the traffic is. The fix is detection by shape plus a **load proof** that says, per tag, whether it loaded and whether it fires, with evidence.
- **So the 5 days start with trust, not features.** Day 1 makes the agent able to prove "loaded" and "firing" against a real-browser baseline. Everything else stacks on that.
- **Each day ends with something you can demo, tests, a dated findings update, and a post for the TAI Labs thread.**

| Day | Theme | Ships | Demo |
|---|---|---|---|
| 1 | Detection you can trust | Shape-based GA4/sGTM detection, load proof per tag, traffic inventory, real-browser parity check | aa.co.nz shows its real GA4 events and tag states |
| 2 | Accurate tables, lean loop | Per-page CSP scope, merged event rows, dataLayer events, consent signals, loop only for plan rows | Clean report on 4 sites with no table defects |
| 3 | The Claude Agent SDK agent | TypeScript agent with in-process tools on the shared core, budget cap | The challenge entry running live, posted Fri 23 Oct |
| 4 | Break it and guard it | Hard-site suite, stability runs, guardrails, golden files | Pass/fail board across 8 sites, 3 runs each |
| 5 | Ship | Preview UI, README, lint and CI, review and PR, deploy preview, site CSP fix | Click-through preview plus Loom |

## 1. Calendar mapping (default, confirm)

The challenge runs 19 to 23 Oct and today (Wed 21) is its Day 3. Default mapping so the challenge milestone lands on time:

| Plan day | Date | Challenge link |
|---|---|---|
| 1 | Wed 21 Oct | challenge Day 3 |
| 2 | Thu 22 Oct | challenge Day 4 |
| 3 | Fri 23 Oct | challenge Day 5: ship and show |
| 4 | Mon 26 Oct | after the challenge |
| 5 | Tue 27 Oct | after the challenge |

If you want all five days inside the challenge window instead, the Agent SDK work moves earlier and detection gets squeezed; I advise against it because the port reuses the detection core.

## 2. What the aa.co.nz run showed (evidence for the reset)

Run in your preview on 2026-10-20 (pageBudget 1) and checked in a real browser on 2026-10-21.

| Observation | Where |
|---|---|
| Tags found: 2 gtag IDs (`G-PNYJZGH4F3`, `G-EMQQPZVZVY`), GTM `GTM-KVZFV7`, inline scripts | agent report |
| Events table empty; gap "tag present but no events observed" with the guess "library had not finished loading" | agent report |
| Real browser: `analytics.aa.co.nz/g/collect?v=2&tid=G-PNYJZGH4F3…` (first-party server-side GTM), `analytics.google.com/g/collect?v=2&tid=G-EMQQPZVZVY…`, `analytics.google.com/g/s/collect`, `stats.g.doubleclick.net/g/collect` | in-app browser, 8 s after load |
| `window.google_tag_manager["GTM-KVZFV7"]` present, `dataLayer` length 3, `gtag` undefined (GTM-driven) | same |
| Consent Mode params on the wire: `gcd=13l3l3l3l1l1`, `dma=0`, `npa=0` | same |
| Reviewer found a custom `quality_traffic` event pushed to `dataLayer` by an inline script, plus `tags:3` mislabelled `other` | agent run log |
| Probe evidence says the CTA click "fired 3 beacons", but the counter includes script loads, so it overstates beacons | `crawl.ts` probe uses `out.fired.length` |
| Local trace upload returned 401 (Langfuse credentials or region mismatch) | SSE `trace` event |

Code cause: `src/browser/capture.ts` matches GA4 only when the host ends in `google-analytics.com` (lines 40-44 and 98-113), so every other GA4 endpoint returns `null` and is dropped before it becomes evidence.

## 3. Day 1: Detection you can trust ("do they load, do they fire?")

**Goal:** for every analytics tag the report says one of five things, with evidence: loaded and firing, loaded but not firing, blocked, referenced but never loaded, or unknown. And what we call a beacon is a beacon.

**Adds**
1. **GA4 by shape, not host.** A request is a GA4 collect when the path is `/g/collect` or `/g/s/collect` (or `/j/collect`) and the query has `v=2` and a `tid=G-…`. Covers `analytics.google.com`, regional hosts, `*.g.doubleclick.net`, and first-party server-side GTM hosts such as `analytics.aa.co.nz`. Learn first-party GA4 hosts the same way PostHog hosts are learned (a script or beacon showing the shape marks the host).
2. **Body-encoded GA4 events.** Parse `en=` and parameters from POST bodies (batched lines), not only the query string.
3. **Consent Mode signals (F3).** Parse `gcd`, `gcs`, `dma`, `npa` into beacon evidence; the consent finding changes from "no consent handling" to "Consent Mode signals present, no banner observed" when they exist.
4. **Load proof per tag** (new evidence kind `loadcheck`, capture source):
   - script request seen and its response status;
   - runtime object: `google_tag_manager[<ID>]`, `dataLayer` length, `gtag`, `posthog.__loaded`;
   - at least one beacon for that tag's destination after the settle window;
   - CSP violation or failed request tied to the tag (already collected).
   The five states are computed by a pure function over this evidence.
5. **Traffic inventory.** Record every third-party host contacted after load (host, request count, resource types, failed count) as evidence. When a tag is "present but silent", the report lists what the page did talk to, and flags analytics-looking requests we did not recognise (path contains `collect`, `/e/`, `/batch`, `/g/`, query has `tid=` or `api_key`). A silent verdict can now be checked by the reader.
6. **Settle strategy.** Replace the fixed 2.5 s wait with: DOM loaded, then network idle (cap 8 s), a scroll to mid and bottom, a short dwell, and a final window. Configurable per run. The "library had not finished loading" wording appears only when the state is genuinely loaded-not-firing after the full settle.
7. **Real-browser parity check** (a script, not a feature of the agent): load a site in the in-app browser, collect resource entries matching analytics patterns, and diff them against the agent's captured set. Any difference is a test fixture and a bug.

**Tests (written first)**
- Classifier fixtures using the exact aa.co.nz URLs above: each of the four GA4 URLs classifies as GA4 with the right `tid`; `analytics.aa.co.nz/_/set_cookie` does not.
- Learned first-party GA4 host: a `/g/collect?v=2&tid=G-…` on an unknown host becomes a known GA4 host, and a later `/g/collect` without `tid` on that host still classifies.
- Body parsing: a two-line POST body yields two events.
- `gcd/dma/npa` parse, and the consent finding switches text.
- Load-proof state machine: each of the five states from a hand-built evidence set.
- Traffic inventory: counts per host; unrecognised analytics-looking request flagged.
- Wording test: "library had not finished loading" never appears unless the state is loaded-not-firing.

**Live acceptance (checked against the real-browser baseline)**
- aa.co.nz: report lists GA4 events from the three GA4 hosts and consent signals; tag states are "loaded and firing" for both `G-` IDs; no "no events observed" finding.
- nobodycame.app: tag state "blocked" with the CSP evidence (unchanged conclusion, now one of five states).
- coffeerouletteapp.com: no regression.

**Risks:** over-matching `/g/collect` on non-Google sites (mitigated by requiring `v=2` and `tid=G-`); regional/ad-product beacons (`ccm/collect`, `ga-audiences`) are Google Ads, not GA4 events, so they go to the inventory, not the events table.

## 4. Day 2: Accurate tables, lean loop

**Goal:** every row in the report is right, and the model is only used where it still writes something.

**Adds** (from workstreams A and B in the roadmap, plus what aa.co.nz exposed)
1. **A1 Per-page CSP scope (F15):** "blocked on N of M pages", severity by coverage, "no events" only if nothing fired anywhere.
2. **A2 Event rows (F16):** merge duplicate keys; load-type auto-events fired during an interaction step stay under `load` with a note.
3. **dataLayer events as evidence:** parse `dataLayer.push({event: …})` custom events (e.g. `quality_traffic`) into an "events seen in dataLayer (not confirmed on the wire)" list, so the reviewer's "missed event" is covered deterministically.
4. **Tag classification:** inline analytics scripts that are not GA/GTM/PostHog stay `other` but carry their detected event names instead of the bare "inline snippet".
5. **Probe counters:** `beaconsFired` becomes `analyticsRequests` plus `beacons` (script loads excluded), fixing the overstated "fired 3 beacons".
6. **B Loop scoped to plan rows (F1):** skip reviewer and Jev when the plan is empty; when rows exist the reviewer may target only `plan:<i>`; add a deterministic table-accuracy lint in the gate.
7. **Langfuse 401:** diagnose the credentials/region mismatch; tracing stays optional and never fails a run.

**Tests (first):** per-page CSP wording cases; merge and note behaviour; dataLayer parsing; probe counter split; zero reviewer calls on an empty plan (fake model); a `gaps:0` critique is rejected; table lint catches a duplicate key.

**Live acceptance:** nobodycame.app, coffeerouletteapp.com, aa.co.nz, posthog.com: zero duplicate rows, zero reviewer critiques about tables, validation rounds 0 or 1 on every run.

## 5. Day 3: The Claude Agent SDK agent (challenge entry, post Fri 23 Oct)

**Goal:** the challenge deliverable, running on the Day 1 and Day 2 core.

One sentence: *My agent reads a website and gives me an evidence-cited audit of its analytics setup, and never claims what it cannot prove.*

**Adds** (design and SDK facts as in roadmap section 5, checked against the Agent SDK docs on 2026-10-21)
1. Folder `challenge/` in this repo; TypeScript, Node 24, local Playwright only.
2. `query()` with an in-process MCP server (`createSdkMcpServer`, `tool()` with zod): `load_page`, `inspect_dom`, `fire_interaction`, `check_loaded` (Day 1 load proof), `finish`. `allowedTools` lists only `mcp__audit__*`. No shell or file tools.
3. `maxBudgetUsd` (default 0.50) and `maxTurns`; handle `error_max_budget_usd` by writing a partial report; read `total_cost_usd` from the result.
4. Report built by the shared pure core (`buildReport`, remedies, `validatePlan`); the model only proposes plan names.
5. CLI: `npx tsx challenge/audit.ts <url> --budget 0.5` prints the markdown report and cost.
6. A `check_setup` command (API key present, browser launches), mirroring the challenge's Day 1 pattern.
7. Thread post: screenshot of the aa.co.nz report plus a 3-line "what it does / what I learned" (the lesson: detect by behaviour, not hostname; the server owns claims).

**Tests (first):** tool handlers return facts only; the agent cannot write evidence (no such tool); budget error yields a partial report (fake result stream); `allowedTools` contains no non-audit tool.

**Live acceptance:** runs end to end on aa.co.nz and nobodycame.app under budget, same findings as the Cloudflare agent on both.

**Needs:** `ANTHROPIC_API_KEY` with API credit (a Claude subscription does not cover the API).

**Risk:** the biggest schedule risk of the five days; mitigated by reusing pure modules and keeping the tool set to five tools.

## 6. Day 4: Break it and guard it

**Goal:** know where it fails before anyone else does.

**Adds**
1. **Hard-site suite** with a ground truth file per site (golden JSON of expected tags, states, event names): nobodycame.app (CSP-blocked PostHog), coffeerouletteapp.com (GA4/GTM), aa.co.nz (sGTM + Consent Mode), posthog.com (PostHog positive), a zero-analytics site, a GTM-only site, an SPA with client routing, a bot-protected or login-walled site.
2. **Stability:** each site run three times; fields that differ between runs are listed. Target: tag set and tag states identical across runs; event sets overlap at least 90%.
3. **Bot and block detection (no evasion):** detect and report when a site serves a challenge page or blocks automation; the agent says "crawl blocked" rather than guessing. Using stealth tooling is out of scope and needs your explicit go-ahead per site.
4. **Guardrails in the Agent SDK version:** per-page step cap, wall-clock cap, domain allow-list (the agent only visits the target's registrable domain and its sitemap), prompt-injection rule (page text is data; tool results never become instructions), redaction of tokens and emails in stored evidence.
5. **Eval board:** a script that runs the suite and prints pass/fail per site per check, with cost per run.
6. **Failure reports:** every budget, timeout or block ends in a labelled partial report, never a confident wrong one.

**Tests (first):** golden-file comparison harness (unit-test the comparer with fake runs); allow-list blocks an off-domain navigation; redaction removes a token from a stored payload.

**Live acceptance:** the board shows all hard sites either passing or failing with a labelled reason; no site produces an unlabelled wrong claim.

## 7. Day 5: Ship

**Goal:** something a stranger can use and trust.

**Adds**
1. **Preview UI** (workstream C): run panel with phases, rendered report, evidence drawer, tag-state badges (the five states), last-20-runs history. Look at it in the in-app browser and save screenshots under `docs/screenshots/<date>-preview/`. Invoke `design-taste-frontend` before markup unless this counts as dense product UI (decide then).
2. **README rewrite (F17)** and a fresh sample report from aa.co.nz and nobodycame.app.
3. **Lint and CI (F18):** a `lint` script (Biome, per the roadmap's recommendation) and a GitHub Actions workflow for install, typecheck, lint and test (check current action versions via Context7 first).
4. **Review and PR:** `/code-review` on the branch, fix correctness findings, open a PR (needs your OK to push).
5. **Rollout:** `cf previews deploy`, run the board against the preview URL, then production only with your approval.
6. **Site fix (F9):** the nobodycame.app CSP patch (add `https://t.nobodycame.app` to `script-src` and `connect-src`), then rerun for the positive-path check.
7. **Loom** and a final post in the thread.

**Acceptance:** the README commands work on a clean clone; CI green; preview matches local output on the board; nobodycame.app shows `$pageview` after the CSP fix.

## 8. Every day, the same close-out

- Tests written first, then code; `npm test` and `npm run typecheck` green.
- Live check on the day's sites against the real-browser baseline (the Day 1 parity script).
- Findings log updated with dates; `CHANGELOG.md` entry for user-visible changes; commit on this branch.
- A short post for the thread: screenshot or Loom, what changed, what broke.
- Anything that does not fit moves down a day explicitly; nothing is silently dropped.

## 9. What is out of scope for the five days

Multi-user accounts, billing, scheduled monitoring, PDF export, languages other than English, stealth browsing, and sites that need a login.

## 10. Open decisions

1. **Calendar:** accept the mapping in section 1 (Day 3 = Fri 23 Oct challenge post, Days 4 and 5 on Mon and Tue)?
2. **One deliverable or two:** the Agent SDK agent (Day 3) is the challenge entry; the Cloudflare agent plus UI (Day 5) is the product. Both ship from the same shared core. Confirm that is the intent, or say which one is "the delivery".
3. **Day 5 UI size:** report view plus evidence drawer and run history, or just the first two?

## Findings log (additions on 2026-10-21)

| ID | Finding | Date found | Status | Date fixed |
|---|---|---|---|---|
| F20 | GA4 recognised only on `google-analytics.com`; aa.co.nz uses `analytics.google.com`, `*.g.doubleclick.net` and first-party sGTM (`analytics.aa.co.nz`), so real events are dropped | 2026-10-21 | Open (Day 1) | n/a |
| F21 | "Tag present but no events observed" guesses "library had not finished loading" without proving the tag loaded or fires | 2026-10-21 | Open (Day 1, load proof) | n/a |
| F22 | Probe field `beaconsFired` counts script loads as beacons | 2026-10-21 | Open (Day 2) | n/a |
| F23 | Custom `dataLayer` events (e.g. `quality_traffic` on aa.co.nz) are not captured as events | 2026-10-21 | Open (Day 2) | n/a |
| F24 | Local trace upload to Langfuse returns 401 | 2026-10-21 | Open (Day 2) | n/a |
