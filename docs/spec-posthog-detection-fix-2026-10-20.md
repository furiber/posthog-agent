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

## Findings log

| ID | Finding | Date found | Status | Date fixed |
|---|---|---|---|---|
| F6 | PostHog missed behind renamed script and proxy host | 2026-10-20 | Spec drafted | n/a |
| F7 | Empty detection still produces invented recommendations | 2026-10-20 | Spec drafted | n/a |
