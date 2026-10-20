import { z } from "zod";
import { Destinations, InteractionKinds } from "./evidence";

/**
 * The report structure: five sections (tag inventory, events & interactions,
 * naming conventions, gaps & misconfigurations, recommendations) plus the
 * Jev validation round log appendix data. Every claim row carries at least
 * one evidence ID; the final gate enforces it.
 */

export const TagInventoryItemSchema = z.object({
  destination: z.enum(Destinations),
  /** Where/how the tag is injected, e.g. "inline <script> in <head>". */
  injectedVia: z.string(),
  /** Page URL(s) where it was seen, or "site-wide". */
  location: z.string(),
  /** Tag identifier detail: PostHog token/api_host, GA4 G- id, GTM container id. */
  detail: z.string(),
  evidenceIds: z.array(z.string().regex(/^E\d{6}$/)).min(1),
  contested: z.boolean().optional(),
});
export type TagInventoryItem = z.infer<typeof TagInventoryItemSchema>;

export const EventRowSchema = z.object({
  eventName: z.string(),
  destinations: z.array(z.enum(Destinations)).min(1),
  interaction: z.enum(InteractionKinds),
  observedOn: z.array(z.string()).min(1),
  /** Property keys observed in the payload. */
  properties: z.array(z.string()),
  evidenceIds: z.array(z.string().regex(/^E\d{6}$/)).min(1),
  notes: z.string().optional(),
  contested: z.boolean().optional(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

export const ConventionStyles = [
  "object_action_snake",
  "snake",
  "camel",
  "kebab",
  "none_discernible",
] as const;
export type ConventionStyle = (typeof ConventionStyles)[number];

export const ConventionSchema = z.object({
  style: z.enum(ConventionStyles),
  /** Human-readable statement of the enforced event-name pattern. */
  eventPattern: z.string(),
  propertyStyle: z.enum(ConventionStyles),
  derivedFrom: z.string(),
  /** 0..1 share of custom event names that follow the derived style. */
  confidence: z.number().min(0).max(1),
  isDefault: z.boolean(),
  /** GA4 is terminology-locked: reserved event/parameter names stay as-is. */
  ga4Note: z.string(),
});
export type Convention = z.infer<typeof ConventionSchema>;

export const GapItemSchema = z.object({
  title: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  detail: z.string(),
  evidenceIds: z.array(z.string().regex(/^E\d{6}$/)).min(1),
  contested: z.boolean().optional(),
});
export type GapItem = z.infer<typeof GapItemSchema>;

export const TrackingPlanRowSchema = z.object({
  action: z.enum(["keep", "rename", "add", "deprecate", "retire"]),
  /** Current event name; null for newly added events. */
  currentName: z.string().nullable(),
  proposedName: z.string(),
  destination: z.enum(Destinations),
  interaction: z.enum(InteractionKinds),
  properties: z.array(z.string()),
  rationale: z.string(),
  evidenceIds: z.array(z.string().regex(/^E\d{6}$/)).min(1),
  priority: z.enum(["P0", "P1", "P2"]),
  contested: z.boolean().optional(),
});
export type TrackingPlanRow = z.infer<typeof TrackingPlanRowSchema>;

/** Adversarial reviewer critique items. */
export const CritiqueTypes = [
  "hallucinated_event",
  "missed_event",
  "misclassified_destination",
  "misclassified_interaction",
  "convention_violation",
  "wrong_recommendation",
  "other",
] as const;
export type CritiqueType = (typeof CritiqueTypes)[number];

export const CritiqueSchema = z.object({
  id: z.string(),
  type: z.enum(CritiqueTypes),
  /** What the critique targets: events:<name>@<dest> | tags:<i> | gaps:<i> | plan:<i> | recs:<i> | convention */
  targetRef: z.string(),
  claim: z.string(),
  citedEvidenceIds: z.array(z.string()),
  proposedFix: z.string().optional(),
});
export type Critique = z.infer<typeof CritiqueSchema>;

export const CritiqueListSchema = z.object({
  critiques: z.array(CritiqueSchema).max(12),
});

export const RoundCritiqueSchema = z.object({
  id: z.string(),
  targetRef: z.string(),
  claim: z.string(),
  verdict: z.enum(["Correct", "Partially Correct", "Incorrect"]),
  confidence: z.number(),
  propagated: z.boolean(),
  flagged: z.boolean(),
});
export type RoundCritique = z.infer<typeof RoundCritiqueSchema>;

export const RoundLogSchema = z.object({
  round: z.number(),
  critiqueCount: z.number(),
  propagated: z.number(),
  critiques: z.array(RoundCritiqueSchema),
});
export type RoundLog = z.infer<typeof RoundLogSchema>;

export const ReportSchema = z.object({
  site: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  requestedUrl: z.string(),
  pageBudget: z.number(),
  pagesVisited: z.array(z.string()),
  pagesFailed: z.array(z.string()),
  models: z.object({
    crawler: z.string(),
    synthesizer: z.string(),
    reviewer: z.string(),
    jev: z.string(),
  }),
  // Section 1
  tagInventory: z.array(TagInventoryItemSchema),
  // Section 2
  events: z.array(EventRowSchema),
  // Section 3
  convention: ConventionSchema,
  // Section 4
  gaps: z.array(GapItemSchema),
  // Section 5
  recommendations: z.array(z.string()),
  trackingPlan: z.array(TrackingPlanRowSchema),
  // Appendix data
  jevRounds: z.array(RoundLogSchema),
  contestedRefs: z.array(z.string()),
  partial: z.boolean(),
  budgetExhausted: z.boolean().optional(),
  error: z.string().optional(),
  /** Set when the crawl found no analytics at all; synthesis and validation were skipped. */
  outcome: z.enum(["no_analytics_detected"]).optional(),
  detectionNote: z.string().optional(),
});
export type Report = z.infer<typeof ReportSchema>;

/** Stable refs for critique targeting. */
export function eventRef(name: string, dest: string): string {
  return `events:${name}@${dest}`;
}
export function tagRef(index: number): string {
  return `tags:${index}`;
}
export function gapRef(index: number): string {
  return `gaps:${index}`;
}
export function planRef(index: number): string {
  return `plan:${index}`;
}
export function recRef(index: number): string {
  return `recs:${index}`;
}
