import { describe, expect, it } from "vitest";
import { buildGaps, buildTagInventory } from "../src/pipeline/synthesize";
import type { Evidence } from "../src/schemas/evidence";
import type { RunStore } from "../src/store";

let n = 0;
function ev(p: Partial<Evidence> & Pick<Evidence, "kind" | "payload">): Evidence {
  n += 1;
  return {
    id: `E${String(n).padStart(6, "0")}`,
    runId: "r",
    site: "example.com",
    pageUrl: "https://example.com/",
    timestamp: "2026-10-20T00:00:00.000Z",
    source: "capture",
    ...p,
  } as Evidence;
}
const storeOf = (items: Evidence[]) => ({ listEvidence: () => items }) as unknown as RunStore;

const phTag = () =>
  ev({
    kind: "snippet",
    dest: "posthog",
    payload: { scriptSrc: "https://t.example.com/static/array.js", tagId: null, note: "tag script load" },
  });
const consentDom = () => ev({ kind: "dom", payload: { consentBannerSelector: null, consentApi: null, note: "no consent banner found in DOM" } });
const diag = (payload: Record<string, unknown>) => ev({ kind: "dom", payload: { cspViolations: [], failedAnalyticsRequests: [], ...payload } });
const beacon = () =>
  ev({ kind: "beacon", dest: "posthog", payload: { eventName: "$pageview", props: {}, requestUrl: "https://t.example.com/e/", method: "POST" } });

const BLOCKED = "Analytics tag present but blocked by the site's Content-Security-Policy";
const FAILING = "Analytics requests are failing";
const NO_EVENTS = "Analytics tag present but no events observed";
const titles = (items: Evidence[]) => buildGaps(storeOf(items), []).map((g) => g.title);

describe("buildGaps: tag present but nothing sent (F10, 2026-10-20)", () => {
  it("reports a HIGH CSP gap that names the blocked URL and directive and cites tag + diagnostics evidence", () => {
    const tag = phTag();
    const d = diag({ cspViolations: [{ blockedUri: "https://t.example.com/static/array.js", directive: "script-src" }] });
    const gaps = buildGaps(storeOf([tag, d, consentDom()]), []);
    const gap = gaps.find((g) => g.title === BLOCKED);
    expect(gap?.severity).toBe("high");
    expect(gap?.detail).toContain("https://t.example.com/static/array.js");
    expect(gap?.detail).toContain("script-src");
    expect(gap?.evidenceIds).toEqual(expect.arrayContaining([tag.id, d.id]));
  });

  it("ignores a CSP violation for an unrelated host", () => {
    const t = titles([phTag(), diag({ cspViolations: [{ blockedUri: "https://static.other.com/beacon.js", directive: "script-src" }] })]);
    expect(t).not.toContain(BLOCKED);
    expect(t).toContain(NO_EVENTS);
  });

  it("reports failing requests with the failure text", () => {
    const gaps = buildGaps(
      storeOf([phTag(), diag({ failedAnalyticsRequests: [{ url: "https://t.example.com/e/", failure: "net::ERR_BLOCKED_BY_CLIENT" }] })]),
      [],
    );
    const gap = gaps.find((g) => g.title === FAILING);
    expect(gap?.severity).toBe("high");
    expect(gap?.detail).toContain("net::ERR_BLOCKED_BY_CLIENT");
  });

  it("with no cause found, reports MEDIUM without claiming a cause", () => {
    const gaps = buildGaps(storeOf([phTag()]), []);
    const gap = gaps.find((g) => g.title === NO_EVENTS);
    expect(gap?.severity).toBe("medium");
    expect(gap?.detail).not.toMatch(/unconditionally/i);
  });

  it("adds none of these gaps when a beacon fired for that destination", () => {
    const t = titles([phTag(), beacon()]);
    expect(t).not.toContain(BLOCKED);
    expect(t).not.toContain(FAILING);
    expect(t).not.toContain(NO_EVENTS);
  });

  it("does not flag a GTM-only site that sent nothing (a container can legitimately be empty)", () => {
    const gtm = ev({ kind: "snippet", dest: "gtm", payload: { scriptSrc: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234", tagId: "GTM-ABC1234" } });
    expect(titles([gtm])).toEqual([]);
  });
});

describe("buildGaps: duplicate beacon replaces the crawler's free-text note (F12, 2026-10-21)", () => {
  const pv = (page: string) =>
    ev({ kind: "beacon", dest: "ga4", pageUrl: page, payload: { eventName: "page_view", props: {}, requestUrl: "https://www.google-analytics.com/g/collect", method: "GET" } });
  const DUP = "Duplicate beacon on one page load";

  it("flags the same event firing twice for one page and cites both beacons", () => {
    const a = pv("https://example.com/remote");
    const b = pv("https://example.com/remote");
    const gap = buildGaps(storeOf([a, b]), []).find((g) => g.title === DUP);
    expect(gap?.severity).toBe("medium");
    expect(gap?.evidenceIds).toEqual([a.id, b.id]);
    expect(gap?.remedy).toContain("page_view");
  });

  it("does not flag two measurement ids each sending their own page_view (aa.co.nz has two G- tags)", () => {
    const withTid = (tid: string) =>
      ev({ kind: "beacon", dest: "ga4", pageUrl: "https://example.com/a", payload: { eventName: "page_view", props: { tid }, tid, requestUrl: "https://analytics.google.com/g/collect", method: "GET" } });
    expect(titles([withTid("G-AAAA1111"), withTid("G-BBBB2222")])).not.toContain(DUP);
    expect(titles([withTid("G-AAAA1111"), withTid("G-AAAA1111")])).toContain(DUP);
  });

  it("only flags events that should fire once per load (PostHog $feature_flag_called legitimately repeats)", () => {
    const flag = () =>
      ev({ kind: "beacon", dest: "posthog", pageUrl: "https://example.com/a", payload: { eventName: "$feature_flag_called", props: {}, requestUrl: "https://t.example.com/e/", method: "POST" } });
    expect(titles([flag(), flag(), flag()])).not.toContain(DUP);
  });

  it("does not flag one beacon, or the same event on different pages", () => {
    expect(titles([pv("https://example.com/a")])).not.toContain(DUP);
    expect(titles([pv("https://example.com/a"), pv("https://example.com/b")])).not.toContain(DUP);
  });
});

describe("buildTagInventory: destination from the script, not from letters inside its name (2026-10-21)", () => {
  it("labels posthog-recorder.js on a posthog host as posthog, not gtag", () => {
    const s = ev({ kind: "snippet", payload: { scriptSrc: "https://us-assets.i.posthog.com/static/1.438.13/posthog-recorder.js", tagId: null } });
    expect(buildTagInventory(storeOf([s]))[0]?.destination).toBe("posthog");
  });

  it("still labels a real gtag id and a GTM container", () => {
    const g = ev({ kind: "snippet", payload: { scriptSrc: "https://www.googletagmanager.com/gtag/js?id=G-ABC1234567", tagId: "G-ABC1234567" } });
    const m = ev({ kind: "snippet", payload: { scriptSrc: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234", tagId: "GTM-ABC1234" } });
    const dests = buildTagInventory(storeOf([g, m])).map((t) => t.destination).sort();
    expect(dests).toEqual(["gtag", "gtm"]);
  });
});

describe("buildGaps: every gap carries a server-written remedy (F11)", () => {
  it("gives the CSP gap a remedy naming the host and directive", () => {
    const d = diag({ cspViolations: [{ blockedUri: "https://t.example.com/static/array.js", directive: "script-src" }] });
    const gap = buildGaps(storeOf([phTag(), d]), []).find((g) => g.title === BLOCKED);
    expect(gap?.remedy).toContain("t.example.com");
    expect(gap?.remedy).toContain("script-src");
  });

  it("gives the no-cause gap a remedy that makes no causal claim", () => {
    const gap = buildGaps(storeOf([phTag()]), []).find((g) => g.title === NO_EVENTS);
    expect(gap?.remedy).toMatch(/verify/i);
  });
});

describe("buildGaps: wording follows the load proof (F21, 2026-10-21)", () => {
  const loadcheck = (over: Record<string, unknown> = {}) =>
    ev({
      kind: "dom",
      payload: {
        loadcheck: true,
        settled: true,
        runtime: { gtmContainers: [], gtagIds: [], dataLayerLength: null, gtag: false, posthog: "absent" },
        scriptStatuses: [],
        ...over,
      },
    });
  const GUESS = /had not finished loading/i;

  it("never guesses 'had not finished loading' when nothing proves the tag loaded", () => {
    const gaps = buildGaps(storeOf([phTag()]), []);
    for (const g of gaps) expect(g.detail).not.toMatch(GUESS);
  });

  it("loaded_not_firing gets its own finding that states the page was fully settled", () => {
    const tag = phTag();
    const lc = loadcheck({ runtime: { gtmContainers: [], gtagIds: [], dataLayerLength: null, gtag: false, posthog: "stub" }, scriptStatuses: [{ src: tag.payload.scriptSrc, status: 200 }] });
    const gap = buildGaps(storeOf([tag, lc]), []).find((g) => g.title === "Analytics tag loaded but sent no events");
    expect(gap?.severity).toBe("medium");
    expect(gap?.detail).toMatch(/settle/i);
    expect(gap?.detail).not.toMatch(GUESS);
  });

  it("referenced_not_loaded gets its own finding", () => {
    const inline = ev({ kind: "snippet", dest: "posthog", payload: { scriptSrc: null, inline: "posthog.init('x')", tagId: null } });
    const gap = buildGaps(storeOf([inline, loadcheck()]), []).find((g) => g.title === "Analytics tag referenced but never loaded");
    expect(gap?.severity).toBe("medium");
  });

  it("lists analytics-looking requests the classifier did not recognise, so a silent verdict can be checked", () => {
    const traffic = ev({
      kind: "dom",
      payload: { traffic: [{ host: "metrics.example.com", count: 3, failed: 0 }], unrecognised: [{ url: "https://metrics.example.com/collect", why: "path contains collect" }] },
    });
    const gap = buildGaps(storeOf([phTag(), traffic]), []).find((g) => g.title === NO_EVENTS);
    expect(gap?.detail).toContain("metrics.example.com");
    expect(gap?.detail).toMatch(/1 analytics-looking request/);
    expect(gap?.evidenceIds).toContain(traffic.id);
  });
});

describe("buildGaps: Consent Mode signals change the consent finding (F3, 2026-10-21)", () => {
  const signalBeacon = () =>
    ev({ kind: "beacon", dest: "ga4", payload: { tid: "G-ABC1234567", eventName: "page_view", props: {}, consentSignals: { gcd: "13l3l3l3l1l1", dma: "0", npa: "0" } } });

  it("says signals are present instead of claiming there is no consent handling", () => {
    const gaps = buildGaps(storeOf([signalBeacon(), consentDom()]), []);
    const t = gaps.map((g) => g.title);
    expect(t).not.toContain("No consent-mode handling observed");
    const gap = gaps.find((g) => g.title === "Consent Mode signals present, no banner observed");
    expect(gap?.severity).toBe("medium");
    expect(gap?.detail).toContain("gcd=13l3l3l3l1l1");
  });

  it("adds no consent finding when a banner exists and signals are present", () => {
    const banner = ev({ kind: "dom", payload: { consentBannerSelector: "#cookie", consentApi: null } });
    const t = buildGaps(storeOf([signalBeacon(), banner]), []).map((g) => g.title);
    expect(t.filter((x) => /consent/i.test(x))).toEqual([]);
  });

  it("keeps the old finding when no beacon carries Consent Mode signals", () => {
    expect(titles([beacon(), consentDom()])).toContain("No consent-mode handling observed");
  });
});

describe("buildGaps: consent gap needs a beacon (F10)", () => {
  it("omits the consent gap when no beacon fired (it would claim beacons fire unconditionally)", () => {
    expect(titles([phTag(), consentDom()])).not.toContain("No consent-mode handling observed");
  });

  it("still emits the consent gap when a beacon fired and no consent API exists", () => {
    expect(titles([phTag(), beacon(), consentDom()])).toContain("No consent-mode handling observed");
  });
});
