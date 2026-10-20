# Spec: Fix PostHog detection (F6) and empty-detection reporting (F7)

**Date:** 2026-10-20 · **Status:** DRAFT, awaiting approval (no code written)
**Parent:** `spec-challenge-fit-and-assessment-2026-10-20.md` (findings F6, F7)

## TL;DR

- **Problem (F6):** PostHog is only detected when the hostname contains "posthog" or the script is named `posthog.js`/`array.js`. nobodycame.app loads `/ph.js` and sends events to a first-party proxy (`t.nobodycame.app`), so the agent saw nothing.
- **Fix (F6):** detect PostHog by what it *is* (runtime object, init call, request shape), not by what it is *called*. Learn the real ingestion host from the page, then classify beacons to that host.
- **Problem (F7):** when nothing is detected, the report still invents fixes (consent mode, `cta_click`) as if tags existed.
- **Fix (F7):** a "no analytics detected" state that says so, lists what was probed, and produces no recommendations.
- **Done when:** a rerun on nobodycame.app reports PostHog with evidence; coffeerouletteapp.com output is unchanged; unit tests cover both.

## 1. Why it fails today (confirmed in code, 2026-10-20)

| Where | What it does | Why nobodycame.app is missed |
|---|---|---|
| `src/browser/capture.ts:30-35` | Script counts as PostHog only if host includes "posthog" and file matches `posthog`/`array`/`posthog-*.js` | Script is `https://nobodycame.app/ph.js`: host and file name both fail |
| `src/browser/capture.ts:86-95` | Ingestion beacon counts only if host includes "posthog" | Beacons go to `t.nobodycame.app` (proxy) so they return `null` |
| `src/browser/pageTools.ts:272-282` | Scans **inline** scripts for `posthog.init(` | The init lives in the external `ph.js`, not inline |
| `src/pipeline/synthesize.ts:161-168` | `inferDest` guesses by text containing "posthog" | Never reached: no evidence was captured |

Ground truth checked by hand: `ph.js` contains `posthog.init`, `api_host:"https://t.nobodycame.app"` and a `phc_` project token. The homepage calls `window.posthog?.capture("audit_submitted")`.

Proxying PostHog through your own domain is a common recommended setup (it avoids ad-blockers), so this miss will repeat on real client sites.

## 2. F6 design: detect by behaviour

Three independent signals; any one produces a PostHog tag evidence item. Each cites its own evidence ID, as today.

1. **Runtime probe (primary).** In the page snapshot, after load, read `window.posthog`: if it exists with `__loaded` true, record `config.api_host`, `config.token` (masked to the first 6 characters, `phc_xxxxxx`) and `config.ui_host`. This works whatever the script is called or where it is hosted.
2. **Script body scan.** For same-origin and first-party scripts, scan the response body for `posthog.init(` or a `phc_` token. Covers pages where the runtime probe is late or blocked.
3. **Request shape.** Classify a request as PostHog ingestion when the path matches the PostHog endpoints and the body carries a `phc_` `api_key`/`token` or a known event shape (`$pageview`, `$autocapture`, `batch` of `{event, properties}`), regardless of host.

Then **learn the host:** the runtime probe (and script scan) yield `api_host`; pass the set of known PostHog hosts into `classifyAnalyticsRequest` so beacons to `t.nobodycame.app` classify as `posthog`. Keep the existing "host includes posthog" rule as a fast path.

Pure-function rule stays: classification remains unit-testable with no browser. The new host set is an argument, not global state.

**Check current PostHog docs via Context7 before coding:** ingestion paths changed over time (`/decide` vs `/flags`, `/e/` vs `/i/v0/e/`, `/s/` for session replay), and the proxy guidance. Do not rely on the paths in this spec from memory.

### 2a. Corrections after the Context7 check and a live probe (2026-10-20)

Checked `/posthog/posthog.com` and `/posthog/posthog-js` docs, then probed nobodycame.app in a browser. Changes to the design above:

1. **No `phc_` requirement.** Docs use `<ph_project_token>`; the posthog-js demo token is `sTMFPsFhdP1Ssg`. Tokens are not guaranteed to start with `phc_`.
2. **Ingestion paths are not stable.** `rewriteRequestPath` (posthog-js 1.416.0+) lets a site rename `/e/`, `/i/v0/e/`, `/s/`, `/flags/`, `/array/`, `/static/`. So path matching alone is unreliable for unknown hosts; use learned hosts. Standard set to match on learned hosts: `/e/`, `/i/v0/e/`, `/batch`, `/s/`, `/flags`, `/decide`.
3. **`/flags/` is the current feature-flag endpoint**; `/decide` still appears in docs. Classify both as config beacons with zero events.
4. **Host-agnostic asset signal.** Docs require proxies to forward `/static/array.js`, `/static/<version>/array.js` and `/array/<token>/config.js`. These paths identify PostHog on any host, and they load *before* any ingestion beacon, so the collector learns the host in time.
5. **Live probe result:** on nobodycame.app `window.posthog` was still the loader stub (no `__loaded`, no `config`), while `https://t.nobodycame.app/static/array.js` had loaded. So the runtime probe cannot be the primary signal. Primary signals become: (a) asset-path shape, (b) `posthog.init(...)` parsed from script bodies (gives `api_host`), (c) runtime object when fully loaded.
6. **False-positive risk accepted:** `/static/array.js` on an unrelated site. Mitigated because every evidence item stores the full URL for the reader to judge.
7. **F7 schema:** `GapItem` requires at least one evidence ID, so the "inconclusive" note cannot be a gap row. It becomes new optional Report fields `outcome` and `detectionNote`.

## 3. F7 design: honest empty state

When the visited pages produced **no tag evidence and no beacons**:

- Section 1 states: "No analytics detected." followed by the list of what was probed (script URLs seen, `window.posthog`, `dataLayer`, `gtag`, network hosts) so the reader can verify.
- Section 4 (gaps): **no consent-mode gap** (it presumes beacons exist) and no "pageview-only" gap. Instead one informational row: "Detection inconclusive: possible causes are tags loaded after user interaction, a consent gate, a login wall, or an unrecognised custom loader."
- Section 5 (recommendations) and the tracking plan: **skipped, no LLM call.** The synthesizer is not invoked, so it cannot invent `consent_granted` or `cta_click`.
- Validation loop (draft, critique, Jev, revise): **skipped**; nothing to adjudicate.
- The run still completes with `partial: false` and a distinct `outcome: "no_analytics_detected"` in the SSE `done` event so callers can tell it apart from a normal audit.

## 4. Out of scope (kept as open findings)

- F1/F2/F8: loop never converges, unsupported recommendations (`cta_click`, `signup_completed`) on sites where tags *are* detected.
- Interaction-triggered events (e.g. `audit_submitted` fires only on form submit). The agent may still not see it.
- posthog.com test (not checked yet).

## 5. Tests

Unit (extend `test/capture.test.ts`, no browser):
1. `/ph.js` script alone is not classified (no false positive on unknown file names).
2. A POST to `https://t.example.com/e/` with a body containing a `phc_` token and `$pageview` classifies as `posthog` beacon with the event parsed.
3. Same request when `t.example.com` is in the learned-host set classifies as `posthog` even without a token in the body.
4. A POST to an unrelated `/e/` path with no PostHog markers returns `null`.
5. Runtime-probe result with `api_host` produces a tag evidence item and adds the host to the set.
6. Empty-state: with zero evidence, `buildGaps` returns only the informational row and the pipeline skips synthesis (assert the synthesizer is not called).

Live (manual, `cf dev`, pageBudget 3):
- nobodycame.app: report lists PostHog (script `ph.js`, host `t.nobodycame.app`, masked token) and at least `$pageview` on the wire.
- coffeerouletteapp.com: tag inventory and event table identical to the 2026-10-20 run (GA4, gtag, GTM; `page_view`, `scroll`).
- A site with genuinely no analytics: `outcome: "no_analytics_detected"`, no recommendations.

## 6. Risks

- **False positives** from the request-shape rule: mitigated by requiring a PostHog marker in the body, not only a path match.
- **Token exposure:** the `phc_` project key is public by design, but the report masks it to 6 characters to keep reports shareable.
- **Runtime probe timing:** PostHog may load async; probe after network idle with a short wait, and fall back to the script-body scan.
- **Slim port:** the classifier stays pure and dependency-free so the Claude Agent SDK TypeScript port can reuse it unchanged.

## 7. Work breakdown (after approval)

1. Context7 check of PostHog endpoint and proxy docs; note any corrections here.
2. Tests first (section 5 unit cases), watch them fail.
3. `capture.ts` + `pageTools.ts` runtime probe and learned-host set.
4. F7 empty-state in `render.ts`, `synthesize.ts` gap builder, and `run.ts` skip path.
5. `npm test`, `npm run typecheck`, live reruns.
6. Update findings log with dates; add a `CHANGELOG.md` entry (user-visible: PostHog now detected behind proxies).

## 8. Build and verification results (2026-10-20)

- Built tests-first. 56/56 tests pass (was 48), `npm run typecheck` clean.
- Deviation from section 2a: `/s/` (session replay) is not classified, to avoid zero-event noise rows; `/flags` and `/decide` are.
- **Live rerun, nobodycame.app:** tag inventory now lists PostHog twice: the proxied `https://t.nobodycame.app/static/array.js` and the `/ph.js` init (`phc_tp… → t.nobodycame.app`). Before: "No analytics tags found".
- **Live rerun, coffeerouletteapp.com:** tags unchanged (gtag, gtm, inline gtm). Event table had `page_view` only this time; the earlier run also had `scroll`. This is crawl-to-crawl variance, not a regression from this change, but it confirms F8-style instability.
- **New finding F9 (real bug on nobodycame.app):** the site's own Content-Security-Policy is `script-src 'self' 'unsafe-inline' https://eu.i.posthog.com`, which blocks `https://t.nobodycame.app/static/array.js` (console shows the CSP violation). PostHog never initialises there, so no events are sent. The agent's "no events on the wire" was correct. Fix on the site: add `https://t.nobodycame.app` to `script-src` and `connect-src`.
- **New finding F10:** the agent still cannot say *why* a detected tag sends nothing. It recommended consent changes and claimed beacons "fire unconditionally" when zero beacons fired. A "tag present, no beacons" gap (citing the CSP console error when available) is the next spec.
- The F7 empty path was covered by unit tests only; no live site with zero analytics was crawled.

## Findings log

| ID | Finding | Date found | Status | Date fixed |
|---|---|---|---|---|
| F6 | PostHog missed behind renamed script and proxy host | 2026-10-20 | Fixed (unit tests + live rerun on nobodycame.app) | 2026-10-20 |
| F7 | Empty detection still produces invented recommendations | 2026-10-20 | Fixed (unit tests; not run live) | 2026-10-20 |
| F9 | nobodycame.app CSP blocks its own PostHog proxy script, so no events are sent | 2026-10-20 | Open (site fix, not in this repo) | n/a |
| F10 | Agent cannot explain "tag present but no beacons"; invents consent advice and a false "beacons fire unconditionally" claim | 2026-10-20 | Open | n/a |
