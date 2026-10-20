import { describe, expect, it } from "vitest";
import { deriveConvention } from "../src/pipeline/convention";
import { validatePlan } from "../src/pipeline/synthesize";
import type { Evidence } from "../src/schemas/evidence";
import type { EventRow, GapItem } from "../src/schemas/report";
import type { RunStore } from "../src/store";

let n = 200;
function ev(p: Partial<Evidence> & Pick<Evidence, "kind" | "payload">): Evidence {
  n += 1;
  return {
    id: `E${String(n).padStart(6, "0")}`,
    runId: "r",
    site: "coffeerouletteapp.com",
    pageUrl: "https://coffeerouletteapp.com/",
    timestamp: "2026-10-21T00:00:00.000Z",
    source: "capture",
    ...p,
  } as Evidence;
}
const storeOf = (items: Evidence[]) => ({ listEvidence: () => items }) as unknown as RunStore;
const convention = deriveConvention([], []);

const pageViewBeacon = ev({ kind: "beacon", dest: "ga4", payload: { eventName: "page_view", props: {} } });
const pageViewRow: EventRow = {
  eventName: "page_view",
  destinations: ["ga4"],
  interaction: "load",
  observedOn: ["https://coffeerouletteapp.com/"],
  properties: ["tid"],
  evidenceIds: [pageViewBeacon.id],
};
const pageviewOnlyGap: GapItem = {
  title: "Pageview-only usage",
  severity: "medium",
  detail: "d",
  evidenceIds: [pageViewBeacon.id],
  remedy: "Add custom events.",
};
const ctaProbe = ev({ kind: "dom", payload: { probe: true, interaction: "cta_click", found: true, beaconsFired: 0, detail: "clicked a visible CTA" } });
const noBanner = ev({ kind: "dom", payload: { consentBannerSelector: null, consentApi: null } });

const row = (over: Record<string, unknown>) => ({
  basis: "gaps:0",
  action: "add" as const,
  currentName: null,
  proposedName: "cta_click",
  destination: "ga4" as const,
  interaction: "click" as const,
  properties: ["cta_text"],
  rationale: "CTA clicks are untracked.",
  priority: "P1" as const,
  ...over,
});

describe("validatePlan: basis and admissibility (F11, 2026-10-21)", () => {
  const evidence = [pageViewBeacon, noBanner];

  it("drops rows with no valid basis", () => {
    const rows = [row({ basis: "" }), row({ basis: "gaps:9" }), row({ basis: "made_up" })];
    expect(validatePlan(rows, [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap])).toEqual([]);
  });

  it("assigns evidence from the basis (the model cannot choose it)", () => {
    const out = validatePlan([row({})], [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap]);
    expect(out).toHaveLength(1);
    expect(out[0].evidenceIds).toEqual([pageViewBeacon.id]);
  });

  it("drops `add cta_click` without a CTA probe, keeps it with one", () => {
    expect(validatePlan([row({})], [pageViewRow], convention, storeOf(evidence), [pageviewOnlyGap])).toEqual([]);
    expect(validatePlan([row({})], [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap])).toHaveLength(1);
  });

  it("drops `add signup_completed` (form_submit) when only a CTA was probed", () => {
    const r = row({ proposedName: "signup_completed", interaction: "form_submit" });
    expect(validatePlan([r], [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap])).toEqual([]);
  });

  it("drops `add consent_granted` when there is no consent banner", () => {
    const r = row({ proposedName: "consent_granted", interaction: "consent_toggle", destination: "gtag" });
    expect(validatePlan([r], [pageViewRow], convention, storeOf(evidence), [pageviewOnlyGap])).toEqual([]);
  });

  it("drops `add consent_update` labelled interaction 'other' (seen live 2026-10-21: no banner, loophole via 'other')", () => {
    const r = row({ proposedName: "consent_update", interaction: "other", destination: "gtm" });
    expect(validatePlan([r], [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap])).toEqual([]);
  });

  it("drops a consent-named `add` row even when labelled 'click' with a CTA probe, unless a banner exists", () => {
    const r = row({ proposedName: "consent_update", interaction: "click" });
    expect(validatePlan([r], [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap])).toEqual([]);
    const banner = ev({ kind: "dom", payload: { consentBannerSelector: "#cookie", consentApi: null } });
    expect(validatePlan([r], [pageViewRow], convention, storeOf([...evidence, ctaProbe, banner]), [pageviewOnlyGap])).toHaveLength(1);
  });

  it("an event basis shared by a load row and a click row resolves to the row with the same interaction", () => {
    const loadBeacon = ev({ kind: "beacon", dest: "ga4", payload: { eventName: "cta_view", props: {} } });
    const clickBeacon = ev({ kind: "beacon", dest: "ga4", interactionStepId: "S-click-4", payload: { eventName: "cta_view", props: {} } });
    const loadRow: EventRow = { ...pageViewRow, eventName: "cta_view", interaction: "load", evidenceIds: [loadBeacon.id] };
    const clickRow: EventRow = { ...loadRow, interaction: "click", evidenceIds: [clickBeacon.id] };
    const keepLoad = row({ action: "keep", currentName: "cta_view", proposedName: "cta_view", interaction: "load", basis: "events:cta_view@ga4" });
    const out = validatePlan([keepLoad], [clickRow, loadRow], convention, storeOf([...evidence, loadBeacon, clickBeacon]), [pageviewOnlyGap]);
    expect(out).toHaveLength(1);
    expect(out[0].evidenceIds).toEqual([loadBeacon.id]);
  });

  it("an `add` row must use a gap basis; keep/rename must use an event basis", () => {
    const addOnEvent = row({ basis: "events:page_view@ga4" });
    expect(validatePlan([addOnEvent], [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap])).toEqual([]);
    const keepOnGap = row({ action: "keep", currentName: "page_view", proposedName: "page_view", interaction: "load", basis: "gaps:0" });
    expect(validatePlan([keepOnGap], [pageViewRow], convention, storeOf(evidence), [pageviewOnlyGap])).toEqual([]);
    const customBeacon = ev({ kind: "beacon", dest: "ga4", payload: { eventName: "cta_click", props: {} } });
    const customRow: EventRow = { ...pageViewRow, eventName: "cta_click", evidenceIds: [customBeacon.id] };
    const keepOk = row({ action: "keep", currentName: "cta_click", proposedName: "cta_click", interaction: "load", basis: "events:cta_click@ga4" });
    const out = validatePlan([keepOk], [customRow], convention, storeOf([...evidence, customBeacon]), [pageviewOnlyGap]);
    expect(out).toHaveLength(1);
    expect(out[0].evidenceIds).toEqual([customBeacon.id]);
  });

  it("drops `keep` rows for reserved platform events: nothing to decide, only something for a reviewer to argue about (aa.co.nz, 2026-10-21)", () => {
    const keepReserved = row({ action: "keep", currentName: "page_view", proposedName: "page_view", interaction: "load", basis: "events:page_view@ga4" });
    expect(validatePlan([keepReserved], [pageViewRow], convention, storeOf(evidence), [pageviewOnlyGap])).toEqual([]);
  });

  it("replaces a rationale that names a URL absent from evidence", () => {
    const r = row({ rationale: "Load https://cdn.example.org/analytics.js earlier." });
    const out = validatePlan([r], [pageViewRow], convention, storeOf([...evidence, ctaProbe]), [pageviewOnlyGap]);
    expect(out).toHaveLength(1);
    expect(out[0].rationale).not.toContain("cdn.example.org");
    expect(out[0].rationale).toContain("Pageview-only usage");
  });
});
