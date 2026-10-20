import { z } from "zod";
import { chatJsonParsed } from "../models";
import { CritiqueListSchema, type Critique, type Report } from "../schemas/report";
import type { RunStore } from "../store";
import { assistantMessage, type Observation, type Trace } from "../trace";

/**
 * Adversarial reviewer: a FRESH context (no conversation with the
 * synthesizer or crawler) with a critique-only system prompt. It gets the
 * draft plus the full evidence digest — including every captured beacon, so
 * it can catch events the draft missed — and outputs structured critique
 * items. Nothing it says is trusted: every item goes to the Jev
 * adjudicator, and only items graded Correct propagate.
 */

const REVIEWER_SYSTEM = `You are an adversarial reviewer for the tracking plan of an analytics instrumentation audit. A model proposed the plan rows below from captured evidence. The tags, events and gaps were built by code from the same evidence and are not up for review. Your only job is to find what is wrong with the PLAN ROWS.

Check each plan row against the evidence that backs it:
(a) wrong recommendation: a row the evidence contradicts, or an "add" row for an interaction the evidence does not show
(b) convention violations: a proposedName that breaks the stated naming convention, or that renames a reserved platform event (GA4 auto events like page_view; PostHog $-prefixed events)
(c) misclassified destination or interaction on the row

Rules:
- Only object when the EVIDENCE supports the objection. Cite the evidence IDs you rely on.
- Only critique plan rows: targetRef must be plan:<i>. Do not nitpick wording. Do not invent events that are not in the evidence.
- At most 6 critiques. Order them by importance.

Reply with ONLY one JSON object:
{"critiques": [{"id": "K1", "type": "wrong_recommendation"|"convention_violation"|"misclassified_destination"|"misclassified_interaction"|"other", "targetRef": "plan:<i>", "claim": "one sentence: what is wrong and what the evidence shows", "citedEvidenceIds": ["E000001"], "proposedFix": "one sentence"}]}`;

/** F1/B: tags, events and gaps are built and checked by code; the reviewer only sees what a model still writes: plan rows. */
export function needsValidation(draft: Report): boolean {
  return draft.trackingPlan.length > 0;
}

/** Keep only critiques aimed at plan rows (`plan:<i>`); a critique of a server-built table is a code bug, not a model error. */
export function scopeCritiques(critiques: Critique[]): Critique[] {
  return critiques.filter((c) => /^plan:\d+$/.test(c.targetRef));
}

export async function adversarialReview(
  env: Record<string, unknown>,
  reviewerModel: string,
  draft: Report,
  store: RunStore,
  sse: (event: string, data: Record<string, unknown>) => unknown,
  trace?: Trace,
  roundObs?: Observation,
  round?: number,
): Promise<Critique[]> {
  // Only plan rows and the evidence that backs them: a fraction of the old digest, which also stops large sites
  // (posthog.com) overflowing the Jev grader's token limit (F25).
  const backing = [...new Set(draft.trackingPlan.flatMap((p) => p.evidenceIds))];
  const digest = {
    report: {
      site: draft.site,
      convention: draft.convention,
      trackingPlan: draft.trackingPlan.map((p, i) => ({
        ref: `plan:${i}`,
        action: p.action,
        currentName: p.currentName,
        proposedName: p.proposedName,
        destination: p.destination,
        interaction: p.interaction,
        priority: p.priority,
        rationale: p.rationale,
        evidenceIds: p.evidenceIds,
      })),
    },
    evidence: store.digest().filter((d) => backing.includes(d.id)),
  };

  sse("phase", { name: "review", status: "critiquing draft" });
  const reviewStartIso = new Date().toISOString();
  const { value, usage } = await chatJsonParsed(
    env,
    { system: REVIEWER_SYSTEM, user: JSON.stringify(digest), model: reviewerModel, maxTokens: 4000 },
    CritiqueListSchema,
  );
  if (trace) {
    const gen = trace.startObservation({
      name: "critique-draft",
      type: "generation",
      parent: roundObs,
      model: reviewerModel,
      input: digest,
      metadata: { round: round ?? 1 },
      startTime: reviewStartIso,
    });
    gen.end({
      output: assistantMessage({ content: JSON.stringify(value) }),
      usage: usage
        ? { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens, cost: usage.cost }
        : undefined,
    });
  }

  // Server normalization: keep critiques honest about evidence IDs.
  const known = new Set(store.listEvidence().map((e) => e.id));
  const critiques = scopeCritiques(value.critiques)
    .slice(0, 12)
    .map((c, i) => ({
      ...c,
      id: c.id || `K${i + 1}`,
      citedEvidenceIds: [...new Set(c.citedEvidenceIds.filter((id) => known.has(id)))].slice(0, 6),
    }))
    .filter((c) => c.claim.trim().length > 0);
  sse("review_done", { critiques: critiques.length });
  return critiques;
}
