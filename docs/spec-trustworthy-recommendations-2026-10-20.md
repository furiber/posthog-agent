# Spec: Stop the LLM plan inventing unsupported recommendations and evidence claims (F11)

**Date:** 2026-10-20 · **Status:** DRAFT, awaiting approval (no code written)
**Parent:** `spec-tag-present-no-beacons-2026-10-20.md` (finding F11)

## TL;DR

- **Problem:** the deterministic parts of the report are now right (tags, events, gaps), but the model-written parts still say things the evidence does not support: `cta_click` "observed", "add `ph.js` to `script-src`", `consent_granted` when no consent banner exists, `signup_completed` citing only page_view beacons.
- **Root causes (all confirmed in code and in the 2026-10-20 runs):**
  1. The crawler model can write its own "evidence" (`record_evidence`), and those notes are cited as proof later. Some were false (it wrote "zero script tags" on a site whose PostHog script it had just loaded).
  2. The gate checks that a cited evidence ID *exists*, never that it *supports* the claim.
  3. Free-text recommendations are not checked at all.
  4. Clicks the crawler really performed leave no evidence unless a beacon fired, so honest "clicked, nothing fired" claims cannot be cited properly.
- **Fix:** the server owns every claim; the model only proposes names. Recommendations are templated from deterministic gaps, plan rows must point at a gap or an observed event and the server assigns their evidence, and any URL or event name in free text must exist in captured evidence.
- **Done when:** a rerun on nobodycame.app and coffeerouletteapp.com has zero plan rows or recommendations that fail the claim checks, and unit tests replay the exact bad outputs seen on 2026-10-20.

## 1. What went wrong (evidence from 2026-10-20 runs)

| # | Bad output | Mechanism | Where |
|---|---|---|---|
| 1 | "CTA clicks were observed on three pages", plan row `cta_click` cites E000005, E000009, E000014 | Crawler notes via `record_evidence` (source `model`) count as evidence. Notes seen in runs: "Homepage loaded with zero analytics beacons, zero script tags, zero init calls" (false: PostHog script was loaded), "clicking a CTA …" | `src/pipeline/crawl.ts:460-481` |
| 2 | `signup_completed` / `cta_click` add rows cite only `page_view` beacons | `validatePlan` keeps a row if any cited ID exists; `finalGate` the same | `synthesize.ts:492-496`, `gate.ts:27` |
| 3 | "Add `https://nobodycame.app/ph.js` to `script-src`" (it loads from `'self'`, so it is not blocked) | `recommendations` are passed through unchecked | `synthesize.ts:439` |
| 4 | `consent_updated`, `consent_granted` proposed on sites with no consent banner | Nothing links an `add` row's interaction to evidence that the interaction exists | `synthesize.ts:478-540` |
| 5 | Real clicks (3 `cta_click` steps on nobodycame.app, 0 or 1 events each) are not citable | Interaction evidence is only stored for fired beacons | `crawl.ts:440` (`recordCaptures(out.fired)`); the attempt itself goes only to `run_log` |

Counts for context: nobodycame.app run 3 had 5 recommendations and 1 correct deterministic gap; coffeerouletteapp.com run 3 had 4 recommendations and 4 plan rows, two of them `add` rows with unrelated cited evidence.

## 2. Design principle

**The server owns claims. The model only proposes names.** A sentence or row reaches the report only if the server can point to the captured evidence that supports it.

### 2.1 Delete model-authored evidence

- Remove the `record_evidence` crawler tool. Everything it was used for is capturable deterministically.
- The one useful finding it produced (GA4 `page_view` firing twice on a page) becomes a deterministic gap in `buildGaps`: "Duplicate beacon on one page load", true when the same destination and event name fire more than once for the same page URL in the load phase, citing those beacon evidence IDs.
- Keep `source` on evidence; as a guard, the gate ignores any `source: "model"` ID when checking support (belt and braces for old runs).

### 2.2 Record every interaction attempt as evidence

In the `fire_interaction` tool, always append a `dom` evidence item (capture source), even when zero beacons fired:

```json
{ "interaction": "cta_click", "detail": "clicked a visible CTA", "beaconsFired": 0, "stepId": "S-click-2" }
```

`captureId = I:<url>:<stepId>` for dedupe. A "no visible CTA found" or "no consent banner found" result is recorded the same way. This is the only legitimate evidence for "this interaction exists but sends nothing".

### 2.3 Recommendations come from templates, not the model

Each deterministic gap has a fixed recommendation text built from its fields. The model writes none.

| Gap (existing or new) | Recommendation template |
|---|---|
| Blocked by CSP | Allow `<blockedUri host>` in `script-src` (and `connect-src` for the ingestion host). |
| Requests failing | Check `<url>`: `<failure>` (ad blocker, network or CORS). |
| Tag present, no events | Verify in a real browser that `<label>` sends events; check consent gating and load timing. |
| No consent-mode handling (only when a beacon fired) | Add a consent banner and Consent Mode (or equivalent) so tags wait for consent. |
| Double counting PostHog + GA4 | Choose one system of record for `<events>` or deduplicate. |
| Pageview-only usage | Add custom events for the interactions that matter; see the tracking plan for named proposals. |
| Duplicate beacon on one page load (new) | Remove the second firing of `<event>` on `<page>`. |
| Messy duplicate names | Standardise `<a>` and `<b>` to one name. |

Each recommendation carries its gap ref and the gap's evidence IDs.

### 2.4 Plan rows need a basis; the server assigns evidence

- Plan output schema changes to `{ basis, action, currentName, proposedName, destination, interaction, properties, rationale, priority }`. Removed: `evidenceIds` and the free-text `recommendations` array.
- `basis` is a ref the server offered in the prompt: a `gaps:<i>` ref or an `events:<name>@<dest>` ref. A row without a valid basis is dropped.
- The row's `evidenceIds` are taken from the basis (gap or event row evidence), never from the model.
- **Admissibility of `add` rows** (the server checks against evidence):

| `add` interaction | Required capture evidence |
|---|---|
| `click` | An interaction probe `cta_click` (2.2) on a page, i.e. a CTA was found and clicked |
| `form_submit` | An interaction probe `form_submit` that found a form |
| `consent_toggle` | Consent evidence with a banner present (`consentBannerSelector` non-null) |
| `load` / `other` | A gap basis only |

  An `add` row that fails its test is dropped with a gate note, not rewritten.
- `rationale` is limited to 300 characters and goes through the claim lint in 2.5.

### 2.5 Claim lint on remaining free text

A pure function `lintClaim(text, corpus)` over rationale (and any other model text), where `corpus` is the concatenated captured evidence payloads plus the visited page URLs:

1. Every URL, host and path-like token (`https?://…`, `/…\.js`) in the text must appear in the corpus. Otherwise the row is dropped (rationale replaced by the template) with a gate note naming the unsupported token.
2. Every event name the text calls "observed", "fires" or "currently" must exist in the events table.
3. Words that assert a count ("on three pages", "twice") are not checked in this round (listed in section 4).

This catches the `ph.js` case: `ph.js` appears in evidence as a tag script but with no CSP block, and the claim "blocked" fails rule 2 of the CSP gap logic, because the model no longer writes that sentence at all (2.3). The lint is the backstop for rationale text.

### 2.6 Model prompt

`PLAN_SYSTEM` is rewritten: the model receives the list of allowed bases and admissible `add` interactions and returns only plan rows. It is told it may return an empty plan. No recommendations are requested.

## 3. Interaction with the validation loop (F1)

The adversarial reviewer and Jev loop stay as they are. Expected effect: far fewer critiques, because claims are server-derived. The loop's non-convergence (F1) is **measured after this change, not fixed here**. If critiques still recur, that is a separate spec.

## 4. Out of scope

- Count claims ("on three pages", "twice") in free text.
- Reviewer prompt changes; Jev threshold tuning.
- The slim Claude Agent SDK port (the lint and admissibility functions stay pure so it can reuse them).

## 5. Tests (unit, replay the real bad outputs)

1. `lintClaim` flags "Add `https://nobodycame.app/ph.js` to `script-src`, since the inline init bundle is itself blocked" against nobodycame.app evidence (URL not in any CSP evidence); passes the true CSP sentence naming `https://t.nobodycame.app/static/array.js`.
2. `add consent_granted` with no banner evidence is dropped; with `consentBannerSelector` set it is kept.
3. `add cta_click` is dropped without an interaction probe, kept with one (`beaconsFired` 0 or more).
4. `add signup_completed` citing only `page_view` beacons is dropped (no form probe).
5. A plan row with no valid `basis`, or a basis that is not in the offered list, is dropped; a valid basis gives the row the gap's evidence IDs regardless of IDs the model sends.
6. `source: "model"` evidence is ignored when checking support.
7. Gap templates: each gap produces a recommendation with the gap's evidence IDs; a CSP gap names the host; no recommendation is produced when there is no gap.
8. New duplicate-beacon gap: two `page_view` beacons for one page URL produce the gap citing both IDs; one beacon does not.
9. `fire_interaction` evidence: an attempt with zero fired beacons still stores an evidence item with `beaconsFired: 0`.

## 6. Live acceptance (cf dev, pageBudget 3)

- nobodycame.app: recommendations are exactly the templated ones from its gaps (CSP block). No `cta_click`, no consent rows, no `ph.js` claim.
- coffeerouletteapp.com: the `keep page_view` row stays. Consent recommendation stays (no banner, beacons fire). No `consent_updated` row (no banner). `cta_click` / `signup_completed` appear only if a form or CTA probe exists, otherwise not.
- Report check script: every plan row and recommendation has a gap or event basis, and every cited ID is `capture` source.
- Record round counts of the validation loop before and after for the F1 comparison.

## 7. Risks and trade-offs

- **Reports get plainer.** Templated recommendations are less fluent than model prose. That is the intent: a short true report beats a long one with invented advice.
- **Fewer `add` proposals.** Coverage suggestions now need interaction evidence. If the crawler fails to find a CTA or form, the plan has no `add` rows. Acceptable for a demo-ready bar; the probe presets can be widened later.
- **Lint false positives:** a legitimate URL in rationale that is not in the corpus gets dropped. The fallback is the template rationale, so no data is lost.
- **Old runs:** persisted reports are unchanged; only new runs use the new pipeline.

## 8. Work breakdown (after approval)

1. Tests first (section 5), watch them fail.
2. Delete `record_evidence`; add duplicate-beacon gap; always-record interaction probes (`crawl.ts`, `synthesize.ts`).
3. Gap-to-recommendation templates (new `src/pipeline/recommend.ts`).
4. New plan schema, basis assignment and `add` admissibility in `validatePlan`; rewrite `PLAN_SYSTEM`.
5. `lintClaim` and gate wiring (`gate.ts`).
6. `npm test`, `npm run typecheck`, live reruns on both sites, compare validation rounds.
7. Findings log, `CHANGELOG.md`, commit.

## 9. Open decisions

1. **Templated recommendations only (recommended) vs. model prose with the lint.** Weak flash-tier models are the failure source; templates are deterministic. The lint alone would still let plausible falsehoods through.
2. **Delete `record_evidence` (recommended) vs. keep it but ignore it for support.** Deleting also removes the false notes that mislead the reviewer.

## Findings log

| ID | Finding | Date found | Status | Date fixed |
|---|---|---|---|---|
| F11 | LLM plan writes unsupported advice around correct deterministic gaps | 2026-10-20 | Spec drafted | n/a |
| F12 | Crawler-authored `record_evidence` notes (some false) are cited as proof | 2026-10-20 | Spec drafted | n/a |
| F13 | Interaction attempts that fire no beacon are not stored as evidence | 2026-10-20 | Spec drafted | n/a |
| F14 | Gate checks that evidence IDs exist, not that they support the claim; recommendations unchecked | 2026-10-20 | Spec drafted | n/a |
