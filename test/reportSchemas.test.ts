import { describe, expect, it } from "vitest";
import {
  CritiqueListSchema,
  EventRowSchema,
  eventRef,
  planRef,
  ReportSchema,
  RoundLogSchema,
  TrackingPlanRowSchema,
  type Report,
} from "../src/schemas/report";

const validEvidenceIds = ["E000001", "E000002"];

const validEventRow = {
  eventName: "cta_click",
  destinations: ["posthog"],
  interaction: "click",
  observedOn: ["https://example.com/pricing"],
  properties: ["cta_text", "page_path"],
  evidenceIds: validEvidenceIds,
};

const validPlanRow = {
  action: "rename",
  currentName: "CTA_Click",
  proposedName: "cta_click",
  destination: "posthog",
  interaction: "click",
  properties: ["cta_text"],
  rationale: "Follows the derived object_action snake convention.",
  evidenceIds: validEvidenceIds,
  priority: "P1",
};

const validReport = {
  site: "example.com",
  runId: "11111111-1111-1111-1111-111111111111",
  startedAt: "2026-10-19T00:00:00.000Z",
  finishedAt: "2026-10-19T00:02:00.000Z",
  requestedUrl: "https://example.com/",
  pageBudget: 4,
  pagesVisited: ["https://example.com/"],
  pagesFailed: [],
  models: { crawler: "z-ai/glm-5.3-flash", synthesizer: "z-ai/glm-5.3-flash", reviewer: "deepseek/deepseek-v4.1-flash", jev: "jev-latest" },
  tagInventory: [
    {
      destination: "posthog",
      injectedVia: "inline <script> in page HTML",
      location: "site-wide (2 pages visited)",
      detail: "posthog token phc_…",
      evidenceIds: validEvidenceIds,
    },
  ],
  events: [validEventRow],
  convention: {
    style: "object_action_snake",
    eventPattern: "object_action snake_case — two lowercase tokens joined by an underscore, e.g. cta_click, signup_completed",
    propertyStyle: "snake",
    derivedFrom: "3 of 4 custom names are snake_case",
    confidence: 0.75,
    isDefault: false,
    ga4Note: "GA4 is terminology-locked: reserved auto-event names stay as GA4 defines them.",
  },
  gaps: [
    {
      title: "No consent-mode handling observed",
      severity: "high",
      detail: "No consent banner and no consent API were observed.",
      evidenceIds: validEvidenceIds,
    },
  ],
  recommendations: ["Keep PostHog as the system of record and route GA4 through it."],
  trackingPlan: [validPlanRow],
  jevRounds: [
    {
      round: 1,
      critiqueCount: 1,
      propagated: 0,
      critiques: [
        {
          id: "K1",
          targetRef: "events:CTA_Click@posthog",
          claim: "The event is fired by a button click, not on load.",
          verdict: "Incorrect",
          confidence: 0.88,
          propagated: false,
          flagged: false,
        },
      ],
    },
  ],
  contestedRefs: [],
  partial: false,
};

describe("Report structure schema", () => {
  it("validates a well-formed five-section report", () => {
    expect(ReportSchema.safeParse(validReport).success).toBe(true);
  });

  it("requires all five sections", () => {
    for (const key of ["tagInventory", "events", "convention", "gaps", "trackingPlan"] as const) {
      const partial = { ...validReport } as Record<string, unknown>;
      delete partial[key];
      expect(ReportSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("requires at least one evidence ID on every claim row (no claim without evidence)", () => {
    expect(EventRowSchema.safeParse({ ...validEventRow, evidenceIds: [] }).success).toBe(false);
    expect(TrackingPlanRowSchema.safeParse({ ...validPlanRow, evidenceIds: [] }).success).toBe(false);
    const noEvidence: Report = JSON.parse(JSON.stringify(validReport));
    noEvidence.events[0]!.evidenceIds = [];
    expect(ReportSchema.safeParse(noEvidence).success).toBe(false);
  });

  it("enforces the E-numbered evidence ID pattern", () => {
    expect(EventRowSchema.safeParse({ ...validEventRow, evidenceIds: ["X1"] }).success).toBe(false);
    expect(EventRowSchema.safeParse({ ...validEventRow, evidenceIds: ["e000001"] }).success).toBe(false);
  });

  it("enforces the interaction and destination vocabularies", () => {
    expect(EventRowSchema.safeParse({ ...validEventRow, interaction: "onload" }).success).toBe(false);
    expect(EventRowSchema.safeParse({ ...validEventRow, destinations: [] }).success).toBe(false);
    expect(EventRowSchema.safeParse({ ...validEventRow, destinations: ["mixpanel"] }).success).toBe(false);
  });

  it("marks contested items instead of dropping them", () => {
    const contested: Report = JSON.parse(JSON.stringify(validReport));
    contested.events[0]!.contested = true;
    contested.contestedRefs = [eventRef("cta_click", "posthog")];
    expect(ReportSchema.safeParse(contested).success).toBe(true);
  });

  it("records partial runs with budget exhaustion", () => {
    const partial = { ...validReport, partial: true, budgetExhausted: true, error: "wall-clock budget exhausted" };
    expect(ReportSchema.safeParse(partial).success).toBe(true);
  });
});

describe("Critique schema (adversarial reviewer output)", () => {
  it("accepts typed critiques and caps the count", () => {
    const one = { critiques: [{ id: "K1", type: "hallucinated_event", targetRef: eventRef("ghost_event", "posthog"), claim: "not in evidence", citedEvidenceIds: ["E000001"] }] };
    expect(CritiqueListSchema.safeParse(one).success).toBe(true);
    const thirteen = { critiques: Array.from({ length: 13 }, (_, i) => ({ id: `K${i}`, type: "other", targetRef: "convention", claim: "x", citedEvidenceIds: [] })) };
    expect(CritiqueListSchema.safeParse(thirteen).success).toBe(false);
  });

  it("rejects unknown critique types", () => {
    const bad = { critiques: [{ id: "K1", type: "spelling_error", targetRef: "convention", claim: "x", citedEvidenceIds: [] }] };
    expect(CritiqueListSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Round log schema", () => {
  it("records verdicts, propagation, and flags", () => {
    const round = {
      round: 2,
      critiqueCount: 2,
      propagated: 1,
      critiques: [
        { id: "K1", targetRef: planRef(0), claim: "rename breaks the convention", verdict: "Correct", confidence: 0.9, propagated: true, flagged: false },
        { id: "K2", targetRef: planRef(1), claim: "unclear", verdict: "Partially Correct", confidence: 0.6, propagated: false, flagged: true },
      ],
    };
    expect(RoundLogSchema.safeParse(round).success).toBe(true);
  });
});
