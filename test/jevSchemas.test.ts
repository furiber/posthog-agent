import { describe, expect, it } from "vitest";
import {
  buildJevCritiqueRequest,
  JEV_CONFIDENCE_FLAG,
  JevRequestSchema,
  JevResponseSchema,
  parseJevGrading,
} from "../src/schemas/jev";

const LIVE_RESPONSE_SHAPE = {
  model: "jev-1.13.0",
  answers: {
    verdict: {
      type: "choice",
      choice: "Correct",
      confidence: 0.93,
      probabilities: { Correct: 0.93, "Partially Correct": 0.05, Incorrect: 0.02 },
    },
  },
  usage: { input_tokens: 272, output_tokens: 20 },
};

describe("Jev request contract", () => {
  it("builds a valid systemone request for a critique item", () => {
    const req = buildJevCritiqueRequest({
      model: "jev-latest",
      critique: "The events table lists signed_up but no evidence shows it.",
      draftStatement: '{"eventName":"signed_up","destinations":["posthog"]}',
      citedEvidence: [{ id: "E000001", payload: { eventName: "$pageview" } }],
    });
    const parsed = JevRequestSchema.safeParse(req);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.questions.verdict.type).toBe("choice");
      expect(Object.keys(parsed.data.questions.verdict.criteria)).toContain("Correct");
      expect(parsed.data.state.critique).toContain("signed_up");
    }
  });

  it("rejects a questions map without the verdict key", () => {
    const req = {
      model: "jev-latest",
      state: { critique: "x", draftStatement: "y", citedEvidence: [] },
      questions: { other: { type: "choice" as const, instructions: "z", criteria: { Correct: "a" } } },
    };
    expect(JevRequestSchema.safeParse(req).success).toBe(false);
  });

  it("requires structured state (claim + evidence), not free text", () => {
    const bad = { model: "jev-latest", state: "just a string", questions: {} };
    expect(JevRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Jev response contract", () => {
  it("parses the live API shape (validated against api.typesafe.ai/v1/systemone)", () => {
    expect(JevResponseSchema.safeParse(LIVE_RESPONSE_SHAPE).success).toBe(true);
  });

  it("tolerates extra fields and a missing usage block", () => {
    const body = { ...LIVE_RESPONSE_SHAPE, answers: { verdict: { ...LIVE_RESPONSE_SHAPE.answers.verdict, extra: 1 } } };
    delete (body as { usage?: unknown }).usage;
    expect(JevResponseSchema.safeParse(body).success).toBe(true);
  });

  it("grades a Correct verdict with confidence", () => {
    const grading = parseJevGrading(LIVE_RESPONSE_SHAPE, "K1");
    expect(grading).not.toBeNull();
    expect(grading?.verdict).toBe("Correct");
    expect(grading?.confidence).toBeCloseTo(0.93);
    expect(grading?.flagged).toBe(false);
  });

  it("flags low-confidence gradings for human review (< 0.7)", () => {
    const body = {
      answers: { verdict: { choice: "Partially Correct", confidence: 0.41, probabilities: { Correct: 0.1, "Partially Correct": 0.41, Incorrect: 0.49 } } },
    };
    const grading = parseJevGrading(body, "K2");
    expect(grading?.flagged).toBe(true);
    expect(JEV_CONFIDENCE_FLAG).toBe(0.7);
  });

  it("rejects unknown choices and missing answers", () => {
    expect(parseJevGrading({ answers: {} }, "K3")).toBeNull();
    expect(
      parseJevGrading({ answers: { verdict: { choice: "Maybe", confidence: 0.9, probabilities: {} } } }, "K4"),
    ).toBeNull();
    expect(parseJevGrading("not json", "K5")).toBeNull();
  });
});
