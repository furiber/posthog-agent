# Spec: Report "tag present but nothing sent" and cite the cause (F10)

**Date:** 2026-10-20 · **Status:** DRAFT, awaiting approval (no code written)
**Parent:** `spec-posthog-detection-fix-2026-10-20.md` (findings F9, F10)

## TL;DR

- **Problem:** on nobodycame.app the agent now finds the PostHog tag but sees zero events, and still tells the reader to add consent handling and claims beacons "fire unconditionally". The real cause is the site's own Content-Security-Policy blocking the PostHog script (F9). The agent has no way to say so.
- **Fix:** record the browser's CSP violations and failed analytics requests as evidence, add a deterministic gap "Tag present but no events sent" that cites them, and stop emitting the consent gap when no beacon fired.
- **Scope:** PostHog and GA4/gtag tags only. A GTM container can legitimately fire nothing, so it is excluded.
- **Done when:** a rerun on nobodycame.app reports a HIGH gap naming the blocked URL and the violated directive (`script-src`), the false consent claim is gone, and coffeerouletteapp.com output is unchanged.

## 1. What we saw (2026-10-20)

| Observation | Source |
|---|---|
| Page CSP is `script-src 'self' 'unsafe-inline' https://eu.i.posthog.com` | Browser console on nobodycame.app |
| Console error: loading `https://t.nobodycame.app/static/array.js` violates that directive and "has been blocked" | Same |
| `window.posthog` stays the loader stub: no `__loaded`, no `config`, no `/e/` request | Same, plus agent run: 0 beacons |
| Agent report: tag found (correct), "No events observed" (correct), consent gap says beacons "fire unconditionally" (false, zero fired) | `rep2-nobody.md` |

Cause in code: nothing listens to the page console (`src/browser/pageTools.ts`, `src/browser/driver.ts`), and `buildGaps` (`src/pipeline/synthesize.ts:179`) emits the consent gap whenever consent evidence exists and no consent API was seen, regardless of whether any beacon fired.

## 2. Design

### 2.1 Capture (browser side)

1. In `CaptureCollector.attach` (or a sibling `PageDiagnostics` class used by `openPage`), listen to `page.on("console")` and keep messages of type `error` whose text matches the CSP pattern `violates the following Content Security Policy directive`.
2. Also listen to `page.on("requestfailed")` and keep failures whose URL is on a known analytics host (posthog, learned proxy host, googletagmanager, google-analytics). Record `failureText` (for example `net::ERR_BLOCKED_BY_CLIENT`, `net::ERR_FAILED`).
3. Pure parser `parseCspViolation(text): { blockedUri, directive } | null`, unit-testable with no browser. Chrome's message format is `Loading the script '<url>' violates the following Content Security Policy directive: "<directive text>"`. Pull the URL and the directive name (the first token, for example `script-src`, `connect-src`).
4. Check the Playwright docs for the console and `requestfailed` event shapes via Context7 before coding, and confirm `@cloudflare/playwright` exposes both (it wraps Playwright, but verify).

### 2.2 Evidence

At `inspect_dom` time (already the per-page diagnostic step), append one `dom` evidence item per page when anything was collected:

```json
{ "cspViolations": [{ "blockedUri": "https://t.nobodycame.app/static/array.js", "directive": "script-src" }],
  "failedAnalyticsRequests": [{ "url": "...", "failure": "net::ERR_BLOCKED_BY_CLIENT" }],
  "note": "console CSP errors and failed analytics requests" }
```

URLs are stored without query strings (reuse `redactUrl`). Deduplicate on `captureId = D:<page>:diag`.

### 2.3 Gap detector (deterministic, no model)

Add to `buildGaps`:

- **Trigger:** the tag inventory contains a `posthog`, `gtag` or `ga4` tag, and there is no beacon evidence for that destination (events table and config beacons both empty for it).
- **If a CSP violation's `blockedUri` host matches the tag's host or a learned PostHog host:**
  - Title: "Analytics tag present but blocked by the site's Content-Security-Policy"
  - Severity: HIGH
  - Detail: names the blocked URL and the directive, and says the fix is to allow that host in `script-src` (and `connect-src` for the ingestion host).
  - Evidence: the tag evidence ID(s) plus the diagnostics evidence ID.
- **Else if a failed analytics request matches:** "Analytics requests are failing" (HIGH), detail with the failure text (ad blocker, network, CORS), evidence as above.
- **Else (no cause found):** "Analytics tag present but no events observed" (MEDIUM), detail lists honest possible causes: events fire only after interaction or consent, the crawl ended before the library finished loading, or an unrecognised block. No recommendation beyond "verify in a real browser".
- Satisfies the existing `GapItem` rule (at least one evidence ID) because the tag evidence is cited.

### 2.4 Stop the false consent claim

In `buildGaps`, emit the consent gap only if at least one analytics beacon was observed. With zero beacons the statement "analytics beacons fire unconditionally" has no support. When the new "present but no events" gap exists, the consent gap is skipped.

### 2.5 Settle before concluding (guard against false alarms)

`openPage` waits 2.5 s after `domcontentloaded`. If a PostHog/gtag tag was recognised but no beacon has arrived, wait up to 5 more seconds and re-collect before inspection. This costs time only on the "tag but no beacon" path.

## 3. Out of scope

- F1/F2/F8 (loop never converges, unsupported `cta_click`/`signup_completed`). The new gap lowers invented advice on this case but does not fix the general problem.
- GTM-only sites with no beacons.
- Fixing nobodycame.app's CSP (separate repo; the report tells the owner what to change).

## 4. Tests

Unit, no browser:
1. `parseCspViolation` extracts `blockedUri` and `directive` from the real nobodycame.app console string; returns null for unrelated errors.
2. `buildGaps` with a fake store (`listEvidence` only): PostHog tag + CSP evidence matching its host gives the HIGH "blocked by CSP" gap citing both IDs.
3. PostHog tag + failed-request evidence gives the "requests failing" gap.
4. PostHog tag + nothing else gives the MEDIUM "no events observed" gap with no causal claim.
5. PostHog tag + at least one beacon: no new gap.
6. Zero beacons: the consent gap is absent. One or more beacons and no consent API: the consent gap is still emitted as today.
7. GTM-only tag with no beacons: no new gap.

Live (`cf dev`, pageBudget 3):
- nobodycame.app: HIGH gap naming `https://t.nobodycame.app/static/array.js` and `script-src`; no consent claim.
- coffeerouletteapp.com: gaps unchanged.
- After the owner fixes the CSP (add `https://t.nobodycame.app` to `script-src` and `connect-src`): rerun shows `$pageview` events and no blocked gap. This is the positive-path check.

## 5. Risks

- Console wording differs across browsers and Chrome versions: parser matches on the stable phrase and degrades to the MEDIUM gap if it fails.
- A CSP violation unrelated to analytics must not trigger the gap: require the blocked host to match a tag or learned host.
- Cloudflare Browser Rendering may not surface console events identically to local Chrome: verify on a deployed preview as well as `cf dev`.
- Slim-port reuse: `parseCspViolation` and the gap logic stay pure so the Claude Agent SDK port can use them unchanged.

## 6. Work breakdown (after approval)

1. Context7 check: Playwright `page.on("console")` and `requestfailed` (and `@cloudflare/playwright` parity).
2. Tests first (section 4 unit cases), watch them fail.
3. Parser, diagnostics collection, evidence at `inspect_dom`.
4. Gap detector and consent-gap condition in `buildGaps`; settle wait in `openPage`.
5. `npm test`, `npm run typecheck`, live reruns on both sites.
6. Update findings log; `CHANGELOG.md` entry; commit.

## Findings log

| ID | Finding | Date found | Status | Date fixed |
|---|---|---|---|---|
| F9 | nobodycame.app CSP blocks its own PostHog proxy script | 2026-10-20 | Open (site fix) | n/a |
| F10 | Agent cannot explain "tag present but no beacons"; false "beacons fire unconditionally" claim | 2026-10-20 | Spec drafted | n/a |
