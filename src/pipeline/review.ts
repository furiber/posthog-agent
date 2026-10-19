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

const REVIEWER_SYSTEM = `You are an adversarial reviewer for an analytics instrumentation audit report. Another agent wrote the report from captured evidence. Your only job is to find what is wrong with it.

Check every claim against the cited evidence:
(a) hallucinated or misread events — an event row whose cited evidence does not actually show that event name or destination
(b) events missed on pages visited — beacons present in the evidence list that the events table omits
(c) misclassified destination or interaction trigger — wrong destination, or wrong interaction (load / click / form_submit / consent_toggle)
(d) convention violations in the proposed rename table — plan rows whose proposedName breaks the stated naming convention, or that rename reserved platform events (GA4 auto events like page_view; PostHog $-prefixed events)
(e) wrong recommendations — recommendations or plan rows that the evidence contradicts

Rules:
- Only object when the EVIDENCE supports the objection. Cite the evidence IDs you rely on.
- Do not nitpick wording. Do not invent events that are not in the evidence list.
- At most 8 critiques. Order them by importance.

Reply with ONLY one JSON object:
{"critiques": [{"id": "K1", "type": "hallucinated_event"|"missed_event"|"misclassified_destination"|"misclassified_interaction"|"convention_violation"|"wrong_recommendation"|"other", "targetRef": "events:<name>@<dests> | gaps:<i> | plan:<i> | convention", "claim": "one sentence: what is wrong and what the evidence shows", "citedEvidenceIds": ["E000001"], "proposedFix": "one sentence"}]}`;

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
  const digest = {
    report: {
      site: draft.site,
      pagesVisited: draft.pagesVisited,
      pagesFailed: draft.pagesFailed,
      tagInventory: draft.tagInventory.map((t, i) => ({
        ref: `tags:${i}`,
        destination: t.destination,
        injectedVia: t.injectedVia,
        location: t.location,
        detail: t.detail,
        evidenceIds: t.evidenceIds,
      })),
      events: draft.events.map((e) => ({
        ref: `${e.eventName}@${e.destinations.join("+")}`,
        eventName: e.eventName,
        destinations: e.destinations,
        interaction: e.interaction,
        observedOn: e.observedOn.slice(0, 4),
        properties: e.properties,
        evidenceIds: e.evidenceIds,
        notes: e.notes,
      })),
      convention: draft.convention,
      gaps: draft.gaps.map((g, i) => ({ ref: `gaps:${i}`, title: g.title, detail: g.detail, evidenceIds: g.evidenceIds })),
      recommendations: draft.recommendations,
      trackingPlan: draft.trackingPlan.map((p, i) => ({
        ref: `plan:${i}`,
        action: p.action,
        currentName: p.currentName,
        proposedName: p.proposedName,
        destination: p.destination,
        interaction: p.interaction,
        priority: p.priority,
        evidenceIds: p.evidenceIds,
      })),
    },
    // Full evidence list — including beacons the report may have missed.
    evidence: store.digest(),
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
  const critiques = value.critiques
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
