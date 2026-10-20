import { z } from "zod";

/** Analytics destinations this agent knows how to detect. */
export const Destinations = ["posthog", "ga4", "gtm", "gtag", "other"] as const;
export type Destination = (typeof Destinations)[number];

/** Evidence kinds: a beacon seen on the wire, a tag snippet in the DOM, or a DOM observation. */
export const EvidenceKinds = ["beacon", "snippet", "dom"] as const;
export type EvidenceKind = (typeof EvidenceKinds)[number];

/** Where the evidence came from: automatic browser capture, or the model recording a note. */
export const EvidenceSources = ["capture", "model"] as const;
export type EvidenceSource = (typeof EvidenceSources)[number];

/** User interaction that fired a beacon. `load` = page load auto-events. */
export const InteractionKinds = [
  "load",
  "click",
  "form_submit",
  "consent_toggle",
  "other",
] as const;
export type InteractionKind = (typeof InteractionKinds)[number];

/**
 * One append-only evidence entry. No report claim may exist without an
 * evidence ID; the final gate enforces it.
 */
export const EvidenceSchema = z.object({
  id: z.string().regex(/^E\d{6}$/),
  runId: z.string(),
  site: z.string(),
  pageUrl: z.string(),
  timestamp: z.string(),
  kind: z.enum(EvidenceKinds),
  source: z.enum(EvidenceSources),
  dest: z.enum(Destinations).optional(),
  captureId: z.string().optional(),
  interactionStepId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** A parsed analytics beacon (what the request interceptor turns into evidence). */
export const BeaconEventSchema = z.object({
  dest: z.enum(Destinations),
  eventName: z.string(),
  props: z.record(z.string(), z.unknown()),
});
export type BeaconEvent = z.infer<typeof BeaconEventSchema>;

/** Result of classifying one network request from the page. */
export const ClassifiedRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("beacon"),
    dest: z.enum(Destinations),
    /** Empty for config endpoints (e.g. PostHog /decide) that carry no events. */
    events: z.array(BeaconEventSchema),
    raw: z.string().optional(),
    /** GA4 measurement id (G-…) when the request carries one. */
    tid: z.string().optional(),
    /** Consent Mode state Google appends to collect requests (gcd, gcs, dma, npa). */
    consent: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal("script"),
    dest: z.enum(Destinations),
    src: z.string(),
    tagId: z.string().optional(),
  }),
]);
export type ClassifiedRequest = z.infer<typeof ClassifiedRequestSchema>;

/** A raw request capture, before it becomes evidence. */
export const CapturedRequestSchema = z.object({
  captureId: z.string(),
  pageUrl: z.string(),
  timestamp: z.string(),
  requestUrl: z.string(),
  method: z.string(),
  classified: ClassifiedRequestSchema,
});
export type CapturedRequest = z.infer<typeof CapturedRequestSchema>;
