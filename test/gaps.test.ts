import { describe, expect, it } from "vitest";
import { buildGaps } from "../src/pipeline/synthesize";
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

  it("does not flag one beacon, or the same event on different pages", () => {
    expect(titles([pv("https://example.com/a")])).not.toContain(DUP);
    expect(titles([pv("https://example.com/a"), pv("https://example.com/b")])).not.toContain(DUP);
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

describe("buildGaps: consent gap needs a beacon (F10)", () => {
  it("omits the consent gap when no beacon fired (it would claim beacons fire unconditionally)", () => {
    expect(titles([phTag(), consentDom()])).not.toContain("No consent-mode handling observed");
  });

  it("still emits the consent gap when a beacon fired and no consent API exists", () => {
    expect(titles([phTag(), beacon(), consentDom()])).toContain("No consent-mode handling observed");
  });
});
