# Evidence: TAI Labs challenge, 2026-10-21

**Date produced:** 2026-10-21 · **Repo:** https://github.com/furiber/posthog-agent (public, MIT) · **Branch:** `docs/challenge-assessment` · **Commits:** `1166cb0` (first Agent SDK agent), `7fd2923` (Day 2)

## Post for the challenge thread (copy and paste)

> **Day 1 to 3: I built an analytics-audit agent with the Claude Agent SDK, and caught my own agent lying to me.**
>
> **What it does:** reads a website and tells you which analytics tags it has (GA4, GTM, PostHog), whether they actually load and fire, and what is wrong. It also says what it could not verify.
>
> **How it works:** the agent gets ONE tool, `capture_page(url)`, backed by a real browser. The tool does the judging in code (each tag gets a proven state: loaded and firing, blocked, loaded but not firing...). The model only quotes those states and writes the explanation. Everything else is denied: no shell, no files, no web search. It refuses any domain except the site it was asked about, and treats page text as data, never as instructions.
>
> **Real results, 24 s and 17 s:**
> - aa.co.nz: GTM and both GA4 properties loaded and firing, `page_view` seen, Consent Mode signals reported, ad traffic and an unknown third-party host listed as "could not verify".
> - my own site, nobodycame.app: PostHog **blocked by my own Content-Security-Policy**, so it had been sending nothing. The agent named the exact fix (allow `t.nobodycame.app` in `script-src`).
>
> **The lesson:** my first version said aa.co.nz had "no events". I checked in a real browser: it had plenty. My detector only recognised `google-analytics.com`, but the site uses `analytics.google.com`, `*.g.doubleclick.net` and its own server-side GTM host. The fix was to identify traffic by what it is, not by hostname, and to add a script that compares my detector with a real browser on every site.
>
> **Also:** I ran it through OpenRouter instead of an Anthropic key. It works, but it took some digging (the SDK was sending the desktop app's own login instead of my key; OpenRouter rejects Claude Code's newest features; `maxBudgetUsd` is unreliable there). Notes are in the repo.
>
> 168 tests, tests written first. Repo: https://github.com/furiber/posthog-agent

## Proof

### Tests and setup (run 2026-10-21)

```
Test Files  14 passed (14)
      Tests  168 passed (168)
typecheck: clean

npm run challenge:check:openrouter -- --live
  ✓ Node 24.12.0
  ✓ Claude Agent SDK 0.3.305 installed
  ✓ OpenRouter key found in root .env (OPENROUTER_API_KEY)
  ✓ Gateway: ANTHROPIC_BASE_URL=https://openrouter.ai/api, ANTHROPIC_API_KEY left empty on purpose
  ✓ Live call worked: "OK" in 3 s
All set.
```

### Detector vs a real browser (`npm run parity -- <url>`)

```
https://www.aa.co.nz/membership
  1x  beacon:ga4  GET  analytics.aa.co.nz/g/collect
  1x  beacon:ga4  GET  analytics.google.com/g/s/collect
  1x  beacon:ga4  GET  stats.g.doubleclick.net/g/collect
  1x  beacon:ga4  POST analytics.google.com/g/collect
  1x  beacon:ga4  POST stats.g.doubleclick.net/g/collect
  2x  script:gtag GET  www.googletagmanager.com/gtag/js
  23 hosts contacted; 12 distinct analytics-looking endpoints; 0 unrecognised request(s).

https://nobodycame.app/
  5 hosts contacted; 0 distinct analytics-looking endpoints; 0 unrecognised request(s).
```

### The agent, live: `npm run challenge:agent -- https://www.aa.co.nz/membership`

```
Auditing https://www.aa.co.nz/membership (model role: sonnet, max turns: 6)
  → capture_page(https://www.aa.co.nz/membership)
**Verdict:** GA4 and GTM are both loaded and firing on `/membership/`. Consent state and the ad-related traffic could not be verified.
| Destination | ID | State | Evidence |
|---|---|---|---|
| GTM | GTM-KVZFV7 | loaded_and_firing | Container loaded, dataLayer length 4. |
| gtag / GA4 | G-PNYJZGH4F3 | loaded_and_firing | Requests captured for this ID. |
| gtag / GA4 | G-EMQQPZVZVY | loaded_and_firing | Requests captured for this ID. |
**Events seen:** `page_view` only, in 5 GA4 requests covering both measurement IDs. The requests went to `analytics.aa.co.nz` (4) and `analytics.google.com` (2). The first looks like a first-party or proxied endpoint.
**Problems found**
1. **Two GA4 properties receive the same hits.** Both G-PNYJZGH4F3 and G-EMQQPZVZVY get `page_view`. If this is not deliberate, it means duplicate data collection.
   - Fix: confirm both are intended and remove the redundant one.
2. **No events beyond `page_view`.** This is a membership sales page, but no CTA clicks, form interactions or video events (YouTube is embedded) fired on load.
   - Fix: check in GTM Preview that the join and CTA interactions are tracked. This audit only captured page load.
3. **Unclassified ad traffic.** `googleads.g.doubleclick.net` (2 requests) and `ad.doubleclick.net` (2) were not matched to any known destination. The "unrecognised" list is empty, so this is only an observation.
   - Fix: identify which GTM tag fires them, for example Google Ads remarketing or Floodlight.
4. **`runtime.gtag` is `false`.** This is odd, since gtag-style GA4 requests are firing. It may just be that GTM manages the tags and no global `gtag` function exists.
   - Fix: none needed unless custom code calls `gtag()`.
No CSP blocks were reported.
**Could not verify**
- **Consent behaviour.** The captured Consent Mode signals were `gcd=13l3l3l3l1l1`, `dma=0` and `npa=0`. I did not decode them. I did not see a consent banner or a before/after-consent comparison, so I can't say whether consent is honoured.
- **Third-party hosts.** `a.optmnstr.com` (16 requests, probably a popup or marketing tool) and the other third-party hosts are unclassified. I can't say whether they are analytics.
- **Other pages.** I did not visit any other page. Behaviour after user interaction, and on other pages or checkout, is untested.
- **GTM contents.** I can't see which tags the GTM container contains.
— 3 model turn(s), 1 page(s) captured, 26 s. Real cost: check your OpenRouter activity page.
```

### The agent, live: `npm run challenge:agent -- https://nobodycame.app/`

```
Auditing https://nobodycame.app/ (model role: sonnet, max turns: 6)
  → capture_page(https://nobodycame.app/)
**Verdict:** Analytics is broken on the page I checked. The site's Content-Security-Policy blocks the PostHog script, so no PostHog events are being sent.
| Destination | ID | State | Evidence |
|---|---|---|---|
| PostHog | not shown | **blocked** | `https://t.nobodycame.app/static/array.js` was blocked by `script-src`. Only a stub exists at runtime (`posthog: "stub"`). |
| Cloudflare Web Analytics | not shown | blocked (the tool did not classify it as a tag) | `static.cloudflareinsights.com/beacon.min.js` was blocked by `script-src`. |
| GTM / GA4 (gtag) | none | none found | `gtmContainers` and `gtagIds` are empty, `gtag` is false, and `dataLayer` is null. |
**Events seen:** None. The tool captured no beacons.
**Problems and fixes**
1. **The CSP blocks PostHog.** The page loads PostHog through a first-party proxy at `t.nobodycame.app`, but `script-src` doesn't allow that host. Fix: add `https://t.nobodycame.app` to `script-src`. Also add it to `connect-src`, which I couldn't check because the tool reported no `connect-src` violations. The reason is that the script never loaded, so it never tried to send data.
2. **The CSP blocks the Cloudflare beacon.** Fix: either add `https://static.cloudflareinsights.com` to `script-src` (and `https://cloudflareinsights.com` to `connect-src`), or remove the beacon if you don't want it. Cloudflare may be injecting it automatically, so you could also turn off Web Analytics auto-injection in the Cloudflare dashboard.
**Could not verify**
- Whether the CSP, and so the blocking, applies to other pages. I only loaded the homepage.
- Whether `t.nobodycame.app` correctly proxies PostHog. Its single request was the blocked script.
- The PostHog project key, and whether any events or pageviews would fire once the script loads.
- Consent Mode or any consent banner. No signals appeared in the result.
- Whether the Cloudflare beacon is deliberate. The result doesn't say how it got onto the page.
— 3 model turn(s), 1 page(s) captured, 17 s. Real cost: check your OpenRouter activity page.
```

## Honest limits

- The agent captures one page by default and cannot click or interact yet.
- It speculates about what the Consent Mode `gcd` string means (it hedges, but a decoder in the tool would be better).
- Cost shown by the SDK is not trustworthy through OpenRouter; the real cost is on the OpenRouter activity page.
- The challenge's own `check_setup.py` only accepts an `sk-ant-` key, so it stays red with OpenRouter. Our equivalent is `npm run challenge:check:openrouter`.
