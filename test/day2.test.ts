import { describe, expect, it } from "vitest";
import { finalGate } from "../src/pipeline/gate";
import { needsValidation, scopeCritiques } from "../src/pipeline/review";
import { buildDataLayerEvents, buildEventRows, buildGaps } from "../src/pipeline/synthesize";
import type { Evidence } from "../src/schemas/evidence";
import type { Critique, EventRow, Report } from "../src/schemas/report";
import { langfuseBaseUrl } from "../src/trace";
import { RunStore } from "../src/store";

let n = 500;
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
/** A store with just what these functions read; interactionFor is the real one (it does not use `this`). */
const storeOf = (items: Evidence[]) =>
  ({ listEvidence: () => items, interactionFor: (e: Evidence) => RunStore.prototype.interactionFor.call({}, e) }) as unknown as RunStore;

const beacon = (eventName: string, over: Partial<Evidence> = {}, dest: Evidence["dest"] = "ga4") =>
  ev({ kind: "beacon", dest, payload: { eventName, props: { tid: "G-AAAA1111" }, tid: "G-AAAA1111", requestUrl: "https://analytics.google.com/g/collect", method: "GET" }, ...over });

describe("buildEventRows: one row per event and interaction (F16/F26, 2026-10-21)", () => {
  it("merges the same event seen several times into one row with all its evidence", () => {
    const rows = buildEventRows(storeOf([beacon("scroll"), beacon("scroll")]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidenceIds).toHaveLength(2);
  });

  it("attributes a page-level auto-event to load when it also fired on load, with a note, instead of a second 'click' row", () => {
    const rows = buildEventRows(storeOf([beacon("page_view"), beacon("page_view", { interactionStepId: "S-click-2" })]));
    expect(rows.map((r) => `${r.eventName}:${r.interaction}`)).toEqual(["page_view:load"]);
    expect(rows[0]!.notes).toMatch(/also fired after click/i);
    expect(rows[0]!.evidenceIds).toHaveLength(2);
  });

  it("does not call an auto-event 'load' when it was only ever seen during a scripted click (aa.co.nz scroll and user_engagement)", () => {
    const rows = buildEventRows(storeOf([beacon("scroll", { interactionStepId: "S-click-2" }), beacon("user_engagement", { interactionStepId: "S-click-2" })]));
    expect(rows.map((r) => `${r.eventName}:${r.interaction}`)).toEqual(["scroll:click", "user_engagement:click"]);
    expect(rows[0]!.notes).toMatch(/only during scripted click/i);
  });

  it("keeps genuinely interaction-driven events under their interaction", () => {
    const rows = buildEventRows(storeOf([beacon("cta_click", { interactionStepId: "S-click-2" }, "posthog"), beacon("$autocapture", { interactionStepId: "S-click-2" }, "posthog")]));
    expect(rows.map((r) => `${r.eventName}:${r.interaction}`)).toEqual(["$autocapture:click", "cta_click:click"]);
  });
});

describe("finalGate merges duplicate event rows the loop may have added (F16)", () => {
  const row = (ids: string[]): EventRow => ({ eventName: "scroll", destinations: ["ga4"], interaction: "load", observedOn: ["https://x/"], properties: ["tid"], evidenceIds: ids });
  const base = (events: EventRow[]): Report => ({
    site: "s", runId: "r", startedAt: "t", finishedAt: "t", requestedUrl: "https://x/", pageBudget: 1, pagesVisited: [], pagesFailed: [],
    models: { crawler: "c", synthesizer: "s", reviewer: "r", jev: "j" },
    tagInventory: [], events, gaps: [], recommendations: [], trackingPlan: [], jevRounds: [], contestedRefs: [], partial: false,
    convention: { style: "object_action_snake", eventPattern: "p", propertyStyle: "snake", derivedFrom: "d", confidence: 0, isDefault: true, ga4Note: "n" },
  });

  it("collapses two rows with the same event, interaction and destinations into one", () => {
    const store = { listEvidence: () => [ev({ id: "E000001", kind: "dom", payload: {} }), ev({ id: "E000002", kind: "dom", payload: {} })] } as unknown as RunStore;
    const out = finalGate(base([row(["E000001"]), row(["E000002"])]), store);
    expect(out.report.events).toHaveLength(1);
    expect(out.report.events[0]!.evidenceIds).toEqual(["E000001", "E000002"]);
    expect(out.notes.join(" ")).toMatch(/merged duplicate event row/i);
  });
});

describe("validation loop is scoped to what a model still writes (B, F1)", () => {
  const critique = (targetRef: string): Critique => ({ id: "K1", type: "other", targetRef, claim: "c", citedEvidenceIds: [] });
  const draft = (plan: number): Report =>
    ({ trackingPlan: Array.from({ length: plan }, (_, i) => ({ proposedName: `e${i}` })) }) as unknown as Report;

  it("needs no validation when the plan is empty (no reviewer, no Jev calls)", () => {
    expect(needsValidation(draft(0))).toBe(false);
    expect(needsValidation(draft(2))).toBe(true);
  });

  it("keeps only critiques that target plan rows; tables are checked by code, not by a reviewer", () => {
    const kept = scopeCritiques([critique("plan:0"), critique("gaps:0"), critique("events:page_view@ga4"), critique("tags:1"), critique("convention"), critique("plan:3")]);
    expect(kept.map((c) => c.targetRef)).toEqual(["plan:0", "plan:3"]);
  });
});

describe("buildGaps: CSP blocks are scoped per page (F15)", () => {
  const A = "https://example.com/a";
  const B = "https://example.com/b";
  const tag = (page: string) => ev({ kind: "snippet", dest: "posthog", pageUrl: page, payload: { scriptSrc: "https://t.example.com/static/array.js", tagId: null } });
  const csp = (page: string) => ev({ kind: "dom", pageUrl: page, payload: { cspViolations: [{ blockedUri: "https://t.example.com/static/array.js", directive: "script-src" }], failedAnalyticsRequests: [] } });
  const fired = (page: string) => ev({ kind: "beacon", dest: "posthog", pageUrl: page, payload: { eventName: "$pageview", props: {}, requestUrl: "https://t.example.com/e/", method: "POST" } });
  const PARTIAL = "Analytics tag blocked by the site's Content-Security-Policy on some pages";
  const BLOCKED = "Analytics tag present but blocked by the site's Content-Security-Policy";
  const titles = (items: Evidence[]) => buildGaps(storeOf(items), []).map((g) => g.title);

  it("says 'on some pages' when the tag also fired on another page", () => {
    const gaps = buildGaps(storeOf([tag(A), tag(B), csp(A), fired(B)]), []);
    const gap = gaps.find((g) => g.title === PARTIAL);
    expect(gap?.severity).toBe("medium");
    expect(gap?.detail).toContain("1 of 2 pages");
    expect(gap?.detail).toContain(A);
    expect(gaps.map((g) => g.title)).not.toContain(BLOCKED);
  });

  it("attributes a violation to the document it happened on, not the page the crawler asked for (a click can navigate to a stricter page; aa.co.nz, 2026-10-21)", () => {
    const afterClick = ev({
      kind: "dom",
      pageUrl: A,
      payload: { cspViolations: [{ blockedUri: "https://t.example.com/static/array.js", directive: "script-src", page: "https://example.com/checkout" }], failedAnalyticsRequests: [] },
    });
    const gap = buildGaps(storeOf([tag(A), tag(B), fired(A), fired(B), afterClick]), []).find((g) => g.title === PARTIAL);
    expect(gap?.detail).toContain("https://example.com/checkout");
    expect(gap?.detail).toMatch(/after navigation/i);
    expect(gap?.detail).not.toContain("1 of 2 pages");
  });

  it("keeps the site-wide HIGH finding when every page with the tag is blocked and nothing fired", () => {
    expect(titles([tag(A), tag(B), csp(A), csp(B)])).toContain(BLOCKED);
  });

  it("reports nothing extra when the CSP did not touch the tag's host", () => {
    const other = ev({ kind: "dom", pageUrl: A, payload: { cspViolations: [{ blockedUri: "https://static.other.com/x.js", directive: "script-src" }], failedAnalyticsRequests: [] } });
    expect(titles([tag(A), fired(A), other])).not.toContain(PARTIAL);
  });
});

describe("buildDataLayerEvents: custom events pushed to the dataLayer, not confirmed on the wire (aa.co.nz quality_traffic)", () => {
  it("reads event names from window.dataLayer contents and inline dataLayer.push calls, skipping gtm.* internals", () => {
    const dl = ev({ kind: "dom", payload: { dataLayer: ['{"event":"gtm.js","gtm.start":1}', '{"event":"quality_traffic","engagement_type":"x"}', '{"gtm.start":1}'], note: "dataLayer contents" } });
    const inline = ev({ kind: "snippet", payload: { initCalls: ["dataLayer.push({ event: 'scroll_depth', percent: 50 })", "gtag('config','G-AAAA1111')"], note: "init calls" } });
    const rows = buildDataLayerEvents(storeOf([dl, inline]));
    expect(rows.map((r) => r.eventName).sort()).toEqual(["quality_traffic", "scroll_depth"]);
    expect(rows[0]!.evidenceIds.length).toBeGreaterThan(0);
  });

  it("returns nothing when the dataLayer only has internal gtm.* events", () => {
    const dl = ev({ kind: "dom", payload: { dataLayer: ['{"event":"gtm.js"}', '{"event":"gtm.dom"}', '{"event":"gtm.load"}'] } });
    expect(buildDataLayerEvents(storeOf([dl]))).toEqual([]);
  });
});

describe("Langfuse base URL (F24, 2026-10-21): keys are for Langfuse Cloud US, the code defaulted to EU and got 401", () => {
  it("defaults to the US cloud, as the config comment and README say", () => {
    expect(langfuseBaseUrl({})).toBe("https://us.cloud.langfuse.com");
  });
  it("honours an explicit base URL and strips a trailing slash", () => {
    expect(langfuseBaseUrl({ LANGFUSE_BASE_URL: "https://cloud.langfuse.com/" })).toBe("https://cloud.langfuse.com");
  });
});
