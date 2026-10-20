# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Custom events pushed to the dataLayer (for example `quality_traffic` on aa.co.nz) are listed under the events table, marked as not confirmed on the wire.
- Interaction probes record analytics requests and beacons separately, so script loads are no longer counted as beacons.
- `npm run challenge:agent -- <url>`: a Claude Agent SDK agent (through OpenRouter) that audits a site's analytics with one browser tool, quotes proven tag states and lists what it could not verify. `npm run challenge:check:openrouter` checks the setup.
- Each tag in the report now has a state: loaded and firing, partially firing, loaded but not firing, blocked, referenced but never loaded, or unknown, with the evidence behind it (window objects such as `google_tag_manager`, script response status, CSP blocks).
- Google Consent Mode signals (`gcd`, `dma`, `npa`) on the wire are reported as "Consent Mode signals present" instead of "no consent handling".
- When a tag is silent, the finding lists analytics-looking requests the crawler did not recognise, so the verdict can be checked.
- When a PostHog or Google Analytics tag is found but no events are sent, the report now says so and, if the browser reported it, names the cause: a Content-Security-Policy block (with the blocked URL and directive) or a failing request.
- A "Duplicate beacon on one page load" finding when the same event fires more than once on a page.
- Every scripted click, form or consent attempt is recorded as evidence, even when nothing was sent.
- `npm run parity -- <url>` loads a site in a real Chromium and lists every analytics-looking request with whether the crawler recognises it.
- Pages are now given a longer settle (network idle, scroll, dwell) before a tag is called silent.

### Changed

- The events table has one row per event and interaction. Page-level auto-events (`page_view`, `scroll`, `user_engagement`) that fired on load are no longer shown a second time as "click" rows, and one seen only during a scripted click is labelled as such.
- The reviewer and Jev grader now only look at tracking-plan rows and are skipped when there are none, so large sites such as posthog.com no longer end as partial reports and runs are faster. The plan no longer lists `keep` rows for reserved platform events.
- A Content-Security-Policy block is reported per page ("blocked on 1 of 2 pages"), attributed to the page it actually happened on, instead of as a site-wide failure.
- Recommendations are now written by the server from the findings, not by the model, so every recommendation maps to a finding with evidence IDs. Tracking-plan rows must point at a finding or an observed event, and new-event proposals (click, form, consent) now require proof the interaction exists on the site.

### Removed

- The crawler can no longer write its own evidence notes; they sometimes contradicted what the browser actually captured.

### Fixed

- Langfuse trace upload returned 401 for US cloud keys because the code defaulted to the EU cloud; it now defaults to the US cloud.
- Google Analytics 4 is now detected on every endpoint it uses: `analytics.google.com`, `*.g.doubleclick.net`, regional hosts and first-party server-side GTM hosts (for example `analytics.aa.co.nz`). Previously only `google-analytics.com` was recognised, so sites like aa.co.nz were reported as having no events. Extra events batched in a POST body are read too.
- PostHog is now detected when it is loaded through a first-party proxy or a renamed loader script (for example `/ph.js` with `api_host` on your own domain); previously such sites were reported as having no analytics.
- A run that finds no analytics at all now says "No analytics detected" and makes no recommendations, instead of inventing consent-mode and `cta_click` advice.
- The "tag present but no events observed" finding no longer guesses that the library "had not finished loading"; its wording now follows the load proof.
- The "no consent-mode handling" finding is no longer reported on pages where no analytics request fired, since its "beacons fire unconditionally" claim had no evidence.
- The "duplicate beacon" finding no longer flags two measurement ids each sending their own `page_view`, or PostHog events that repeat by design. A PostHog `posthog-recorder.js` script is no longer labelled as Google Analytics.
