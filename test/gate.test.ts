import { describe, expect, it } from "vitest";
import { finalGate } from "../src/pipeline/gate";
import type { Evidence } from "../src/schemas/evidence";
import type { Report } from "../src/schemas/report";
import type { RunStore } from "../src/store";

const mk = (id: string, source: Evidence["source"]): Evidence =>
  ({ id, runId: "r", site: "s", pageUrl: "https://s/", timestamp: "t", kind: "dom", source, payload: {} }) as Evidence;

const report = (): Report => ({
  site: "s",
  runId: "r",
  startedAt: "t",
  finishedAt: "t",
  requestedUrl: "https://s/",
  pageBudget: 1,
  pagesVisited: [],
  pagesFailed: [],
  models: { crawler: "c", synthesizer: "s", reviewer: "r", jev: "j" },
  tagInventory: [],
  events: [],
  convention: { style: "object_action_snake", eventPattern: "p", propertyStyle: "snake", derivedFrom: "d", confidence: 0, isDefault: true, ga4Note: "n" },
  gaps: [
    { title: "backed by capture", severity: "high", detail: "d", evidenceIds: ["E000001"] },
    { title: "backed only by a model note", severity: "high", detail: "d", evidenceIds: ["E000002"] },
  ],
  recommendations: [],
  trackingPlan: [],
  jevRounds: [],
  contestedRefs: [],
  partial: false,
});

describe("finalGate (F12, 2026-10-21): crawler-authored notes are not support", () => {
  it("drops a claim whose only cited evidence is source=model", () => {
    const store = { listEvidence: () => [mk("E000001", "capture"), mk("E000002", "model")] } as unknown as RunStore;
    const out = finalGate(report(), store);
    expect(out.report.gaps.map((g) => g.title)).toEqual(["backed by capture"]);
    expect(out.notes.join(" ")).toContain("backed only by a model note");
  });
});
