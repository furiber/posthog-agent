import { z } from "zod";

/**
 * Jev (TypeSafe systemone API) contract — the live API shape, validated
 * against `https://api.typesafe.ai/v1/systemone` (model `jev-latest`):
 *
 *   POST /v1/systemone
 *   { "state": {...}, "model": "jev-latest",
 *     "questions": { "<key>": { "type": "choice", "instructions": "...",
 *                               "criteria": { "<choice>": "...", ... } } } }
 *   -> { "model": "jev-1.13.0",
 *        "answers": { "<key>": { "type": "choice", "choice": "...",
 *                                "confidence": 0.93,
 *                                "probabilities": { "...": 0.93, ... } } },
 *        "usage": { "input_tokens": 272, "output_tokens": 20 } }
 *
 * The grade scale for this build is Choice over
 * Correct / Partially Correct / Incorrect.
 */

export const JevVerdicts = ["Correct", "Partially Correct", "Incorrect"] as const;
export type JevVerdict = (typeof JevVerdicts)[number];

/** Answers below this confidence are flagged for human review in the appendix. */
export const JEV_CONFIDENCE_FLAG = 0.7;

export const JevQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1),
  criteria: z.record(z.string(), z.string()),
});

export const JevStateSchema = z.object({
  critique: z.string(),
  draftStatement: z.string(),
  citedEvidence: z.array(z.unknown()),
});

export const JevRequestSchema = z.object({
  model: z.string().min(1),
  state: JevStateSchema,
  questions: z
    .record(z.string(), JevQuestionSchema)
    .refine((q) => "verdict" in q, { message: "questions must key the verdict question as 'verdict'" }),
});
export type JevRequest = z.infer<typeof JevRequestSchema>;

export const JevAnswerSchema = z
  .object({
    type: z.literal("choice").optional(),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()),
  })
  .passthrough();

export const JevResponseSchema = z
  .object({
    model: z.string().optional(),
    answers: z.record(z.string(), JevAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type JevResponse = z.infer<typeof JevResponseSchema>;

/** One graded critique item. */
export const JevGradingSchema = z.object({
  critiqueId: z.string(),
  verdict: z.enum(JevVerdicts),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
  flagged: z.boolean(),
});
export type JevGrading = z.infer<typeof JevGradingSchema>;

export const JEV_CRITIQUE_INSTRUCTIONS =
  "Is this objection well-founded given the evidence? Compare the critique to the cited evidence and the draft statement it targets. Reply with one choice.";

export const JEV_CRITIQUE_CRITERIA: Record<string, string> = {
  Correct:
    "The critique is well-founded: the cited evidence supports the objection, and the objection truthfully applies to the draft statement.",
  "Partially Correct":
    "The critique is partly well-founded, but it overstates the problem, misreads part of the evidence, or applies only conditionally.",
  Incorrect:
    "The critique is not well-founded: the evidence contradicts it, it misreads the draft statement, or it raises no real problem.",
};

/** Build the systemone request for one critique item. */
export function buildJevCritiqueRequest(args: {
  model: string;
  critique: string;
  draftStatement: string;
  citedEvidence: unknown[];
}): JevRequest {
  return {
    model: args.model,
    state: {
      critique: args.critique,
      draftStatement: args.draftStatement,
      citedEvidence: args.citedEvidence,
    },
    questions: {
      verdict: {
        type: "choice",
        instructions: JEV_CRITIQUE_INSTRUCTIONS,
        criteria: JEV_CRITIQUE_CRITERIA,
      },
    },
  };
}

/** Parse a systemone response body into a grading; tolerant of missing keys. */
export function parseJevGrading(
  body: unknown,
  critiqueId: string,
): JevGrading | null {
  const parsed = JevResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const answer = parsed.data.answers["verdict"];
  if (!answer) return null;
  const verdict = JevVerdicts.find((v) => v === answer.choice);
  if (!verdict) return null;
  return {
    critiqueId,
    verdict,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    flagged: answer.confidence < JEV_CONFIDENCE_FLAG,
  };
}
