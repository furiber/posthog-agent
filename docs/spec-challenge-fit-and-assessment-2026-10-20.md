# Spec: Does the PostHog/Analytics Audit Agent work, and does it fit the TAI Labs challenge?

**Date:** 2026-10-20 · **Status:** DRAFT, awaiting approval (no code written)

## TL;DR

- The agent **runs end to end**: 48/48 unit tests pass, the pipeline (crawl, draft, adversarial review, Jev grading, revision, report) is built, and a sample report exists. I did **not** run a live crawl this session.
- It **does not yet produce trustworthy reports**. In the only sample (coffeerouletteapp.com, 3 pages) the validation loop never converged: 3 of 3 rounds ended with 5 Jev-Correct critiques, and 6 items shipped flagged as contested.
- Root causes are visible in the sample: weak flash-tier models invent unsupported recommendations (`cta_click`, `signup_completed`) and make claims the evidence contradicts ("no consent handling" despite `gcd`/`npa`/`dma` params on the wire).
- **PostHog is untested.** The sample site only uses GA4/GTM. Nothing shows PostHog detection working.
- **Challenge mismatch:** the challenge is the *Claude Agent SDK* (Python/TS, Day 1 to Day 5, ship by Fri 23 Oct). This agent is built on the Cloudflare Agents SDK + OpenRouter flash models + Vercel AI SDK. It is a strong project but not an SDK-challenge entry as it stands.

## 1. The challenge (read from TAI Labs on Skool, 2026-10-20)

- 5-Day Challenge: Build Your First AI Agent with the Claude Agent SDK, 19 to 23 Oct 2026.
- Day 1 setup, Day 2 give it tools, Day 3 make it useful for a real task, Day 4 break it, fix it, add guardrails, Day 5 ship it and show us.
- Post a screenshot or short Loom in the challenge thread each day.
- You pick your own agent. One-sentence test: "My agent reads ___ and gives me ___."
- Reference repo (Aki's job-fit agent): github.com/akshika47/AI-Internship/tree/main/claude-agent-sdk-challenge. Only Day 1 is published; uses `uv`, `ANTHROPIC_API_KEY`, `max_budget_usd` per run.
- Your earlier comment in the thread: define exactly what the agent is and does.

## 2. What the agent is

One sentence: **it reads a website and gives me an evidence-cited audit of its analytics setup (PostHog / GA4 / GTM) plus a tracking plan.**

Stack: Cloudflare Workers + Agents SDK (Durable Object per run), Browser Rendering via `@cloudflare/playwright`, OpenRouter (DeepSeek V4.1 flash, GLM 5.3 flash), TypeSafe Jev grader, Langfuse tracing.

## 3. Evidence on "does it work"

| Question | Evidence | Verdict |
|---|---|---|
| Builds and unit tests pass | `npm test`: 5 files, 48 tests passed (2026-10-20) | Works |
| Typechecks | not run this session | Unknown |
| Crawls and captures beacons | Sample report shows GA4 `page_view`/`scroll`, gtag, GTM with evidence IDs | Works on GA4/GTM |
| Detects PostHog | No PostHog run in the sample; commit log says "validated" but no artifact | **Unproven** |
| Validation loop converges | 3/3 rounds still had 5+ Jev-Correct critiques; 6 contested items | **Does not converge** |
| Claims match evidence | K3/K5/K6 critiques show it contradicts its own evidence | **Unreliable** |
| Stable across runs | README step 4 asks for this; no run log | Unproven |

## 4. Why (hypotheses, to confirm in the walkthrough)

1. **Weak model plus open-ended synthesis.** The synthesizer writes recommendations that cite page_view beacons as evidence for click/form events. Recommendations should be derived from detected gaps by rules, not free-written.
2. **Revision step does not fix what Jev confirms.** Same critiques recur across rounds (signup_completed, consent). The revise step is not acting on them.
3. **Crawl too shallow to support "no X exists" claims.** 3 pages cannot prove absence of consent banners or custom events. Absence claims need a coverage threshold or must be worded as "not observed".
4. **Event classification is too coarse.** `scroll` labelled interaction "load" despite `percent_scrolled=90`. Consent Mode params are on the wire but not parsed.
5. **Jev confidence is often below 0.7** (several flagged), so the gate is acting on low-confidence verdicts.

## 5. Proposed work, once approved

**Phase A: Assess (no code changes)**
1. Run `npm run typecheck`.
2. Live run on a known PostHog site, `pageBudget` 3 and 10, twice each.
3. Score each report against a short checklist: PostHog detected, events correct, zero unsupported claims.
4. Update this file with dated findings (Date found, Status).

**Phase B: Decide the challenge route** (needs your pick, see questions)

**Phase C: Fix (separate spec)**
- Parse Consent Mode params; detect PostHog by `/e/`, `/decide`, `posthog-js` signals.
- Make recommendations rule-derived; absence claims gated on coverage.
- Stop the loop when critiques repeat unchanged; surface as contested.

## 6. Decisions (2026-10-20, from walkthrough)

1. **Challenge route:** slim port to the Claude Agent SDK as the challenge entry; the Cloudflare agent stays as the larger product.
2. **Test targets:** coffeerouletteapp.com (known GA4/GTM, negative case for PostHog) and nobodycame.app (expected PostHog positive; to be confirmed by the run).
3. **Success bar:** demo-ready. Runs on one PostHog site, detects PostHog, and no claim contradicts its own evidence.

4. **Language:** TypeScript for the slim port, to reuse `src/browser/capture.ts` and `src/pipeline/convention.ts`. Before writing code, check current Claude Agent SDK TypeScript docs via Context7 (custom tools, budget option).

## 7. Phase A results (2026-10-20, live runs, pageBudget 3, local `cf dev`)

- `npm run typecheck`: passes, no errors.
- Both runs finished (`partial: false`): coffeerouletteapp.com in 208 s, 23 evidence items; nobodycame.app in 98 s, 7 evidence items.
- **coffeerouletteapp.com:** GA4 + GTM found correctly. The same weaknesses as the 19 Oct sample came back: all 3 review rounds had Jev-Correct critiques, and the plan still adds `cta_click` and `signup_completed` citing only page_view beacons.
- **nobodycame.app: false negative.** The report says "No analytics tags found" and recommends adding consent mode and `cta_click`. Ground truth: the site loads PostHog via `/ph.js` (`posthog.init`, `api_host: https://t.nobodycame.app`, a first-party proxy) and calls `posthog.capture("audit_submitted")`.
- **Cause (confirmed in code):** `src/browser/capture.ts` lines 30-34 and 86 only recognise PostHog when the host contains "posthog" or the file is named `posthog.js`/`array.js`. A renamed script (`ph.js`) and a proxy host (`t.nobodycame.app`) are both missed. Proxying PostHog is the recommended setup to dodge ad-blockers, so this will hit real sites often.
- Not tested: posthog.com (curl found no markers in raw HTML; needs a browser-level check).

## Findings log

| ID | Finding | Date found | Status | Date fixed |
|---|---|---|---|---|
| F1 | Validation loop never converges (sample run, 3/3 rounds) | 2026-10-20 | Open | n/a |
| F2 | Unsupported recommendations ship (`cta_click`, `signup_completed`) | 2026-10-20 | Open | n/a |
| F3 | "No consent handling" contradicted by Consent Mode params | 2026-10-20 | Open | n/a |
| F4 | PostHog detection has no recorded evidence | 2026-10-20 | Superseded by F6 | n/a |
| F6 | PostHog missed on nobodycame.app: detection needs "posthog" in host or filename; site uses `/ph.js` and proxy `t.nobodycame.app` (capture.ts:30-34, 86) | 2026-10-20 | Open | n/a |
| F7 | On a site with no detected tags the report invents fixes (consent mode, `cta_click`) instead of saying "detection inconclusive" | 2026-10-20 | Open | n/a |
| F8 | F1-F2 reproduced on a fresh run (coffeerouletteapp.com, 3/3 rounds with Jev-Correct critiques) | 2026-10-20 | Open | n/a |
| F5 | Stack differs from challenge (Claude Agent SDK) | 2026-10-20 | Open | n/a |
