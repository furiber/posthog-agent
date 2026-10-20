import { describe, expect, it } from "vitest";
import { computeTagStates } from "../src/pipeline/loadproof";
import type { Evidence } from "../src/schemas/evidence";
import type { TagInventoryItem } from "../src/schemas/report";

let n = 300;
function ev(p: Partial<Evidence> & Pick<Evidence, "kind" | "payload">): Evidence {
  n += 1;
  return {
    id: `E${String(n).padStart(6, "0")}`,
    runId: "r",
    site: "www.aa.co.nz",
    pageUrl: "https://www.aa.co.nz/membership",
    timestamp: "2026-10-21T00:00:00.000Z",
    source: "capture",
    ...p,
  } as Evidence;
}

const runtime = (over: Record<string, unknown> = {}) => ({
  gtmContainers: [],
  gtagIds: [],
  dataLayerLength: null,
  gtag: false,
  posthog: "absent",
  ...over,
});
const loadcheck = (over: Record<string, unknown> = {}) =>
  ev({ kind: "dom", payload: { loadcheck: true, settled: true, runtime: runtime(), scriptStatuses: [], ...over } });
const ga4Beacon = (tid: string) => ev({ kind: "beacon", dest: "ga4", payload: { tid, requestUrl: "https://analytics.google.com/g/collect", method: "GET", events: [] } });

const gtagScript = (id: string) =>
  ev({ kind: "snippet", dest: "gtag", payload: { scriptSrc: `https://www.googletagmanager.com/gtag/js?id=${id}`, tagId: id } });
const gtagItem = (scripts: Evidence[], ids = "G-PNYJZGH4F3, G-EMQQPZVZVY"): TagInventoryItem => ({
  destination: "gtag",
  injectedVia: "script src (www.googletagmanager.com)",
  location: "site-wide",
  detail: ids,
  evidenceIds: scripts.map((s) => s.id),
});
const stateOf = (item: TagInventoryItem, evidence: Evidence[]) => computeTagStates([item], evidence)[0]!;

describe("computeTagStates: do the tags load, and do they fire? (F21, 2026-10-21)", () => {
  const scripts = [gtagScript("G-PNYJZGH4F3"), gtagScript("G-EMQQPZVZVY")];
  const statuses = scripts.map((s) => ({ src: s.payload.scriptSrc, status: 200 }));

  it("loaded_and_firing when every measurement id has a beacon", () => {
    const out = stateOf(gtagItem(scripts), [...scripts, loadcheck({ scriptStatuses: statuses }), ga4Beacon("G-PNYJZGH4F3"), ga4Beacon("G-EMQQPZVZVY")]);
    expect(out.state).toBe("loaded_and_firing");
  });

  it("partially_firing when only some ids fire, naming the silent one", () => {
    const out = stateOf(gtagItem(scripts), [...scripts, loadcheck({ scriptStatuses: statuses }), ga4Beacon("G-PNYJZGH4F3")]);
    expect(out.state).toBe("partially_firing");
    expect(out.stateDetail).toContain("G-EMQQPZVZVY");
  });

  it("loaded_not_firing when the script loaded, the page settled and nothing was sent", () => {
    const out = stateOf(gtagItem(scripts), [...scripts, loadcheck({ scriptStatuses: statuses })]);
    expect(out.state).toBe("loaded_not_firing");
  });

  it("blocked when the browser reported a CSP violation for the tag's host", () => {
    const csp = ev({
      kind: "dom",
      payload: { cspViolations: [{ blockedUri: "https://www.googletagmanager.com/gtag/js", directive: "script-src" }], failedAnalyticsRequests: [] },
    });
    const out = stateOf(gtagItem(scripts), [...scripts, loadcheck(), csp]);
    expect(out.state).toBe("blocked");
    expect(out.stateDetail).toContain("script-src");
  });

  it("referenced_not_loaded when the tag appears only in inline HTML and nothing loaded or ran", () => {
    const inline = ev({ kind: "snippet", dest: "gtag", payload: { scriptSrc: null, inline: "gtag('config','G-PNYJZGH4F3')", tagId: null } });
    const out = stateOf({ ...gtagItem([inline], "G-PNYJZGH4F3"), injectedVia: "inline <script> in page HTML" }, [inline, loadcheck()]);
    expect(out.state).toBe("referenced_not_loaded");
  });

  it("unknown when the crawl did not finish settling, so silence proves nothing", () => {
    const out = stateOf(gtagItem(scripts), [...scripts, loadcheck({ settled: false, scriptStatuses: statuses })]);
    expect(out.state).toBe("unknown");
  });

  it("treats a beacon with the tid as proof the tag loaded even without a script status", () => {
    const out = stateOf(gtagItem([scripts[0]!], "G-PNYJZGH4F3"), [scripts[0]!, loadcheck(), ga4Beacon("G-PNYJZGH4F3")]);
    expect(out.state).toBe("loaded_and_firing");
  });
});

describe("computeTagStates: PostHog and GTM", () => {
  const phScript = ev({ kind: "snippet", dest: "posthog", payload: { scriptSrc: "https://t.example.com/static/array.js", tagId: null } });
  const phItem = (): TagInventoryItem => ({ destination: "posthog", injectedVia: "script src (t.example.com)", location: "site-wide", detail: "https://t.example.com/static/array.js", evidenceIds: [phScript.id] });
  const phBeacon = ev({ kind: "beacon", dest: "posthog", payload: { eventName: "$pageview", props: {}, requestUrl: "https://t.example.com/e/", method: "POST" } });

  it("PostHog: loaded library plus a beacon is loaded_and_firing", () => {
    const out = stateOf(phItem(), [phScript, loadcheck({ runtime: runtime({ posthog: "loaded" }) }), phBeacon]);
    expect(out.state).toBe("loaded_and_firing");
  });

  it("PostHog: script loaded but the library stayed a stub is loaded_not_firing and says it did not initialise", () => {
    const out = stateOf(phItem(), [phScript, loadcheck({ runtime: runtime({ posthog: "stub" }), scriptStatuses: [{ src: phScript.payload.scriptSrc, status: 200 }] })]);
    expect(out.state).toBe("loaded_not_firing");
    expect(out.stateDetail).toMatch(/initialis/i);
  });

  const gtmScript = ev({ kind: "snippet", dest: "gtm", payload: { scriptSrc: "https://www.googletagmanager.com/gtm.js?id=GTM-KVZFV7", tagId: "GTM-KVZFV7" } });
  const gtmItem = (): TagInventoryItem => ({ destination: "gtm", injectedVia: "script src (www.googletagmanager.com)", location: "site-wide", detail: "GTM-KVZFV7", evidenceIds: [gtmScript.id] });

  it("GTM: container object present and a busy dataLayer is loaded_and_firing", () => {
    const out = stateOf(gtmItem(), [gtmScript, loadcheck({ runtime: runtime({ gtmContainers: ["GTM-KVZFV7"], dataLayerLength: 3 }) })]);
    expect(out.state).toBe("loaded_and_firing");
  });

  it("GTM: container present but an idle dataLayer and no beacons is loaded_not_firing", () => {
    const out = stateOf(gtmItem(), [gtmScript, loadcheck({ runtime: runtime({ gtmContainers: ["GTM-KVZFV7"], dataLayerLength: 1 }) })]);
    expect(out.state).toBe("loaded_not_firing");
  });

  it("unknown for destinations we cannot judge", () => {
    const other: TagInventoryItem = { destination: "other", injectedVia: "inline", location: "site-wide", detail: "inline snippet", evidenceIds: [phScript.id] };
    expect(stateOf(other, [phScript, loadcheck()]).state).toBe("unknown");
  });
});
