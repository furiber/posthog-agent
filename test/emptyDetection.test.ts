import { describe, expect, it } from "vitest";
import { asEmptyDetectionReport } from "../src/pipeline/empty";
import { renderMarkdown } from "../src/pipeline/render";
import type { Report } from "../src/schemas/report";

const base: Report = {
  site: "example.com",
  runId: "11111111-1111-1111-1111-111111111111",
  startedAt: "2026-10-20T00:00:00.000Z",
  finishedAt: "2026-10-20T00:01:00.000Z",
  requestedUrl: "https://example.com/",
  pageBudget: 3,
  pagesVisited: ["https://example.com/", "https://example.com/about"],
  pagesFailed: [],
  models: { crawler: "c", synthesizer: "s", reviewer: "r", jev: "jev-latest" },
  tagInventory: [],
  events: [],
  convention: {
    style: "none_discernible",
    eventPattern: "default",
    propertyStyle: "snake",
    derivedFrom: "none",
    confidence: 0,
    isDefault: true,
    ga4Note: "GA4 is terminology-locked.",
  },
  gaps: [],
  recommendations: [],
  trackingPlan: [],
  jevRounds: [],
  contestedRefs: [],
  partial: false,
};

describe("asEmptyDetectionReport (F7, 2026-10-20)", () => {
  it("marks a run with no tags and no events as no_analytics_detected", () => {
    const out = asEmptyDetectionReport(base);
    expect(out?.outcome).toBe("no_analytics_detected");
    expect(out?.detectionNote).toMatch(/inconclusive/i);
    expect(out?.recommendations).toEqual([]);
    expect(out?.trackingPlan).toEqual([]);
    expect(out?.gaps).toEqual([]);
  });

  it("returns null when a tag was found, so the normal pipeline runs", () => {
    const withTag: Report = {
      ...base,
      tagInventory: [
        { destination: "posthog", injectedVia: "script src", location: "site-wide", detail: "phc_tp…", evidenceIds: ["E000001"] },
      ],
    };
    expect(asEmptyDetectionReport(withTag)).toBeNull();
  });

  it("renders an honest report: no invented advice, no consent or cta_click recommendations", () => {
    const md = renderMarkdown(asEmptyDetectionReport(base)!);
    expect(md).toContain("No analytics detected");
    expect(md).toMatch(/inconclusive/i);
    expect(md).not.toMatch(/consent_granted|cta_click|signup_completed/);
    expect(md).not.toContain("## 5. Recommendations");
    expect(md).toContain("2 pages visited");
  });
});
