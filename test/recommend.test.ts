import { describe, expect, it } from "vitest";
import { addAdmissible, evidenceCorpus, interactionProbePayload, lintClaim, recommendationsFromGaps } from "../src/pipeline/recommend";
import type { Evidence } from "../src/schemas/evidence";
import type { GapItem } from "../src/schemas/report";

let n = 100;
function ev(p: Partial<Evidence> & Pick<Evidence, "kind" | "payload">): Evidence {
  n += 1;
  return {
    id: `E${String(n).padStart(6, "0")}`,
    runId: "r",
    site: "nobodycame.app",
    pageUrl: "https://nobodycame.app/",
    timestamp: "2026-10-21T00:00:00.000Z",
    source: "capture",
    ...p,
  } as Evidence;
}

const gap = (title: string, severity: GapItem["severity"], remedy: string | undefined, ids = ["E000001"]): GapItem => ({
  title,
  severity,
  detail: "d",
  evidenceIds: ids,
  ...(remedy ? { remedy } : {}),
});

describe("recommendationsFromGaps (F11, 2026-10-21): templated, never model-written", () => {
  it("returns nothing when there are no gaps", () => {
    expect(recommendationsFromGaps([])).toEqual([]);
  });

  it("uses each gap's remedy plus its evidence IDs, highest severity first, deduplicated, capped at 6", () => {
    const gaps = [
      gap("low one", "low", "Fix low."),
      gap("high one", "high", "Allow t.nobodycame.app in script-src.", ["E000001", "E000008"]),
      gap("dup", "medium", "Fix low."),
      ...Array.from({ length: 8 }, (_, i) => gap(`m${i}`, "medium", `Remedy ${i}.`)),
    ];
    const recs = recommendationsFromGaps(gaps);
    expect(recs[0]).toBe("Allow t.nobodycame.app in script-src. (E000001, E000008)");
    expect(recs.filter((r) => r.startsWith("Fix low."))).toHaveLength(1);
    expect(recs.length).toBe(6);
  });

  it("skips gaps without a remedy", () => {
    expect(recommendationsFromGaps([gap("no remedy", "high", undefined)])).toEqual([]);
  });
});

describe("lintClaim: unsupported URLs and paths (replays 2026-10-20 output)", () => {
  const tagScript = ev({ kind: "snippet", dest: "posthog", payload: { scriptSrc: "https://nobodycame.app/ph.js", tagId: "phc_tp… → t.nobodycame.app" } });
  const csp = ev({
    kind: "dom",
    payload: { cspViolations: [{ blockedUri: "https://t.nobodycame.app/static/array.js", directive: "script-src" }], failedAnalyticsRequests: [] },
  });
  const corpus = evidenceCorpus([tagScript, csp]);

  it("flags 'ph.js ... blocked': ph.js is a tag script in evidence but was never blocked", () => {
    const bad = "Add https://nobodycame.app/ph.js to script-src, since the inline init bundle is itself blocked on /app-store.";
    expect(lintClaim(bad, corpus)).toMatch(/ph\.js/);
  });

  it("passes the true CSP sentence naming the blocked array.js", () => {
    const ok = "The page blocks https://t.nobodycame.app/static/array.js (script-src).";
    expect(lintClaim(ok, corpus)).toBeNull();
  });

  it("flags a URL that appears nowhere in evidence", () => {
    expect(lintClaim("Load https://cdn.example.org/analytics.js earlier.", corpus)).toMatch(/cdn\.example\.org/);
  });

  it("passes plain text with no URLs", () => {
    expect(lintClaim("Records explicit opt-in.", corpus)).toBeNull();
  });
});

describe("evidenceCorpus ignores model-authored evidence (F12)", () => {
  it("does not let a crawler note vouch for a URL", () => {
    const note = ev({ kind: "dom", source: "model", payload: { note: "Saw https://evil.example/x.js blocked" } });
    expect(lintClaim("Fix https://evil.example/x.js", evidenceCorpus([note]))).toMatch(/evil\.example/);
  });
});

describe("addAdmissible: an `add` row needs evidence that the interaction exists", () => {
  const probe = (interaction: string, found: boolean, source: Evidence["source"] = "capture") =>
    ev({ kind: "dom", source, payload: { probe: true, interaction, found, beaconsFired: 0, detail: "d" } });
  const banner = ev({ kind: "dom", payload: { consentBannerSelector: "#cookie", consentApi: null } });
  const noBanner = ev({ kind: "dom", payload: { consentBannerSelector: null, consentApi: null } });

  it("click: needs a found cta_click probe (zero fired beacons is fine)", () => {
    expect(addAdmissible("click", [])).toBe(false);
    expect(addAdmissible("click", [probe("cta_click", false)])).toBe(false);
    expect(addAdmissible("click", [probe("cta_click", true)])).toBe(true);
  });

  it("form_submit: needs a found form probe", () => {
    expect(addAdmissible("form_submit", [probe("cta_click", true)])).toBe(false);
    expect(addAdmissible("form_submit", [probe("form_submit", true)])).toBe(true);
  });

  it("consent_toggle: needs a consent banner (consent_granted with no banner is nonsense)", () => {
    expect(addAdmissible("consent_toggle", [noBanner])).toBe(false);
    expect(addAdmissible("consent_toggle", [banner])).toBe(true);
  });

  it("ignores probes written by the model", () => {
    expect(addAdmissible("click", [probe("cta_click", true, "model")])).toBe(false);
  });

  it("load/other are never admissible for `add`: labelling a new event 'other' must not bypass the probes", () => {
    expect(addAdmissible("load", [probe("cta_click", true), banner])).toBe(false);
    expect(addAdmissible("other", [probe("cta_click", true), banner])).toBe(false);
  });
});

describe("interactionProbePayload (F13): attempts that fire nothing are still evidence", () => {
  it("records a found click that fired no beacons", () => {
    expect(interactionProbePayload("cta_click", "clicked a visible CTA", 0, "S-click-2")).toMatchObject({
      probe: true,
      interaction: "cta_click",
      found: true,
      beaconsFired: 0,
      stepId: "S-click-2",
    });
  });

  it("marks 'no ...' results as not found", () => {
    expect(interactionProbePayload("cta_click", "no visible CTA found (outside nav/header/footer)", 0, "S-click-1").found).toBe(false);
    expect(interactionProbePayload("consent_toggle", "no consent banner found", 0, "S-consent-1").found).toBe(false);
    expect(interactionProbePayload("form_submit", "no form found on the page", 0, "S-form-1").found).toBe(false);
    expect(interactionProbePayload("form_submit", "interaction error: timeout", 0, "S-form-2").found).toBe(false);
  });
});
