# Analytics instrumentation audit — coffeerouletteapp.com

> Run `caa88fc9-a512-4cce-9852-4c27c9eb0868` · started 2026-10-19T10:06:37.789Z · page budget 3 · pages visited 3
> Models: crawler `z-ai/glm-5.3-flash`, synthesizer `z-ai/glm-5.3-flash`, adversarial reviewer `deepseek/deepseek-v4.1-flash`, Jev grader `jev-latest`

## 1. Tag inventory

| Destination | Injected via | Location | Detail | Evidence |
|---|---|---|---|---|
| gtag | script src (www.googletagmanager.com) | site-wide (3 pages visited) | G-0T3X6LH02P | E000001, E000007, E000010 |
| gtm | script src (www.googletagmanager.com) | site-wide (3 pages visited) | GTM-MBPPV5M8 | E000002, E000006, E000011 |
| gtm | inline <script> in page HTML | site-wide (3 pages visited) | inline snippet | E000003, E000012, E000021 |

## 2. Events & interactions

_A naming-conventions table of all events sent through and the interactions when they occur._

| Event | Destinations | Interaction (when it occurs) | Observed on | Properties | Evidence |
|---|---|---|---|---|---|
| `page_view` | ga4 | load | coffeerouletteapp.com/business-case<br>coffeerouletteapp.com/remote-isolation | tid | E000008, E000017 |
| `scroll` | ga4 | load | coffeerouletteapp.com/business-case | tid, percent_scrolled | E000009 |

## 3. Naming conventions

- **Event style:** _none discernible — default applied_ → `object_action_snake` — object_action snake_case — two lowercase tokens joined by an underscore, e.g. cta_click, signup_completed
- **Property style:** `snake`
- **Derived from:** no custom event names observed on the wire (only reserved auto-events); default convention applied (confidence 0%)
- GA4 is terminology-locked: its reserved auto-event names (page_view, session_start, scroll, form_submit, ...) and parameter names stay exactly as GA4 defines them. Renames in the tracking plan never apply to GA4 reserved events; GA4 custom event names may follow the site convention.

## 4. Gaps & misconfigurations

| Severity | Gap | Detail | Evidence |
|---|---|---|---|
| HIGH | No consent-mode handling observed | No consent banner and no consent API were observed on any visited page; analytics beacons fire unconditionally, which is a compliance risk for EU traffic. | E000005, E000014, E000023 |
| MEDIUM | Pageview-only usage | Only auto pageview events were observed on the wire across every visited page — no custom events at all. | E000008, E000017 |

## 5. Recommendations

- Keep the reserved GA4 page_view auto-event as-is; it is correctly firing on all pages but must not be duplicated by a parallel pageview push in the dataLayer.
- Keep the reserved GA4 scroll auto-event, which is already capturing percent_scrolled correctly.
- Implement Google Consent Mode with a consent banner before loading tags, since beacons currently fire unconditionally on every page.
- Add a cta_click event to cover user interactions, since the site currently tracks no custom events at all.
- Add a signup_completed event to measure the core conversion, filling the pageview-only coverage gap.

### Tracking plan (diffable: current → proposed)

| Action | Current | Proposed | Destination | Interaction | Properties | Priority | Rationale | Evidence |
|---|---|---|---|---|---|---|---|---|
| keep | `scroll` | `scroll` | ga4 | load | tid, percent_scrolled | P2 | Reserved GA4 auto-event already capturing scroll depth with percent_scrolled. | E000009 |
| add | — | `consent_granted` | gtag | consent_toggle | consent_analytics, consent_marketing | P0 | No consent banner or Consent Mode was observed anywhere, so analytics fires unconditionally; gate all tags and emit a consent event when the user opts in. | E000005, E000014, E000023 |

Priority order: P0 → P2 (P0 first).

## Appendix A. Jev validation log

### Round 1 — 6 critique(s), 5 Jev-Correct (propagated)

| ID | Target | Critique | Jev verdict | Confidence | Propagated |
|---|---|---|---|---|---|
| K1 | plan:0 | The recommendation to 'retire the duplicate pageview dataLayer push ... observed on /remote-isolation' is contradicted by the evidence: the only /remote-isolation beacon rows show a single page_view (E000017) and an events-less config hit ( | Incorrect | 0.02 ⚠️<0.7 | no |
| K2 | events:page_view@ga4 | The claim that page_view 'is correctly firing on all pages' is unsupported: no page_view beacon was captured on the homepage (its evidence E000001-E000005 contains only tag scripts, dataLayer content and a consent check), and only /business | Correct | 0.51 ⚠️<0.7 | yes |
| K3 | gaps:1 | gaps:1 states 'Only auto pageview events were observed on the wire across every visited page — no custom events at all', yet the events table itself lists a scroll beacon with percent_scrolled on /business-case (E000009) and a custom dataLa | Correct | 0.91 | yes |
| K4 | plan:3 | plan:3/plan:4 cite only page_view beacons (E000008, E000017) as evidence for adding cta_click and signup_completed, but no click, form, or form_submit evidence exists anywhere in the evidence list, so the claimed 'cta_click' and conversion  | Correct | 0.74 | yes |
| K5 | gaps:0 | The gap states no consent-mode handling was observed, but the captured g/collect payloads carry Consent Mode state parameters (`gcd=13l3l3l3l1l1`, `npa=0`, `dma=0`), indicating default consent signals are already being sent even without a b | Correct | 0.79 | yes |
| K6 | recommendations:4 | Recommendation 5's justification ('the site currently tracks no custom events at all') conflicts with the report's own finding of a custom 'pageview' dataLayer push present on every page (E000004, E000013, E000022). | Correct | 0.66 ⚠️<0.7 | yes |

### Round 2 — 5 critique(s), 5 Jev-Correct (propagated)

| ID | Target | Critique | Jev verdict | Confidence | Propagated |
|---|---|---|---|---|---|
| K1 | recommendations:3 | The recommendation to retire a duplicate 'pageview' dataLayer push on /remote-isolation is contradicted by the evidence: E000017 shows exactly one page_view beacon on that page and E000022 shows exactly one 'pageview' entry in the dataLayer | Correct | 0.72 | yes |
| K2 | events:scroll@ga4 | scroll is classified with interaction 'load', but E000009 shows percent_scrolled=90, which is a scroll-depth trigger rather than a page-load trigger. | Correct | 0.97 | yes |
| K3 | gaps:1 | The gap is titled 'Pageview-only usage' and claims only auto pageview events were observed, but E000009 shows an auto scroll event with percent_scrolled on /business-case, which the gap omits even though it is in the evidence list. | Correct | 0.91 | yes |
| K4 | recommendations:5 | The recommendation to add signup_completed to measure 'the core conversion' cites only the page_view beacons (E000008, E000017); no signup form, form_submit interaction, or conversion signal appears anywhere in the evidence. | Correct | 0.86 | yes |
| K5 | plan:2 | consent_granted is assigned destination 'gtag', the tag-loading tool, while the consent evidence (E000005, E000014, E000023) only shows that no consent banner or consent API exists, and GA4 consent handling is a consent-mode command rather  | Correct | 0.69 ⚠️<0.7 | yes |

### Round 3 — 5 critique(s), 5 Jev-Correct (propagated)

| ID | Target | Critique | Jev verdict | Confidence | Propagated |
|---|---|---|---|---|---|
| K1 | gaps:1 | The gap claims 'Only auto pageview events were observed on the wire ... no custom events at all', but E000009 clearly shows a scroll beacon (percent_scrolled=90) on the wire, and the report's own events table and recommendation 2 acknowledg | Correct | 0.88 | yes |
| K2 | events:scroll@ga4 | E000024 states the /remote-isolation page fired two page_view beacons alongside one scroll event, yet the events table lists scroll@ga4 only on /business-case (E000009) and page_view@ga4 only once per page, omitting both the remote-isolatio | Correct | 0.13 ⚠️<0.7 | yes |
| K3 | plan:3 | plan:3 adds signup_completed with interaction form_submit citing E000008/E000017, but both evidence IDs are plain page_view beacons with only a tid prop and show no form, form submission, or signup interaction anywhere on the visited pages. | Correct | 0.98 | yes |
| K4 | plan:0 | Recommendation 1 asserts page_view 'must not be duplicated by a parallel pageview push in the dataLayer', but E000004/E000013/E000022 show exactly such a dataLayer push ({event:'pageview', page:'/…'}) on every page and E000024 confirms a du | Correct | 0.25 ⚠️<0.7 | yes |
| K5 | plan:2 | plan:2 adds consent_granted with interaction consent_toggle citing only E000005/E000014/E000023, which all report consentBannerSelector:null and consentApi:null, i.e. absence of any consent UI — the evidence cannot demonstrate a consent_tog | Correct | 0.89 | yes |

## Appendix B. Contested items (shipped, not dropped)

- events:page_view@ga4 — Jev-Correct critique could not be resolved against the evidence; the item ships with an explicit contested flag.
- gaps:1 — Jev-Correct critique could not be resolved against the evidence; the item ships with an explicit contested flag.
- gaps:0 — Jev-Correct critique could not be resolved against the evidence; the item ships with an explicit contested flag.
- recommendations:5 — Jev-Correct critique could not be resolved against the evidence; the item ships with an explicit contested flag.
- plan:2 — Jev-Correct critique could not be resolved against the evidence; the item ships with an explicit contested flag.
- events:scroll@ga4 — Jev-Correct critique could not be resolved against the evidence; the item ships with an explicit contested flag.
