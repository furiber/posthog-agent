import { z } from "zod";
import { chatJsonParsed } from "../models";
import type { Evidence } from "../schemas/evidence";
import {
  eventRef,
  type EventRow,
  type GapItem,
  type Report,
  type TagInventoryItem,
  type TrackingPlanRow,
} from "../schemas/report";
import type { RunStore } from "../store";
import { conformsTo, deriveConvention, isReservedEventName, toConvention, type DerivedConvention } from "./convention";
import { assistantMessage, type Observation, type Trace } from "../trace";

/**
 * Synthesizer: turns the evidence store into a draft report. The tables are
 * assembled deterministically from evidence (weak models never enumerate
 * rows); the single model step proposes the tracking plan, and its output is
 * server-validated against the evidence IDs and the derived convention.
 */

const PLAN_SYSTEM = `You write the recommended tracking plan for an analytics instrumentation audit.

Input: the observed events table, the site's naming convention, and detected gaps, all as JSON.

Reply with ONLY one JSON object:
{"recommendations": string[], "plan": [{"action": "keep"|"rename"|"add"|"deprecate"|"retire", "currentName": string|null, "proposedName": string, "destination": "posthog"|"ga4"|"gtm"|"gtag"|"other", "interaction": "load"|"click"|"form_submit"|"consent_toggle"|"other", "properties": string[], "rationale": string, "evidenceIds": string[], "priority": "P0"|"P1"|"P2"}]}

Rules:
- proposedName MUST follow the stated naming convention exactly.
- Never rename reserved platform events (GA4 auto events like page_view; PostHog $-prefixed events). For those use keep, deprecate, or retire only.
- evidenceIds must be IDs from the provided evidence list.
- keep: currentName === proposedName, and currentName exists in the events table.
- rename: currentName exists in the events table and proposedName is different and follows the convention.
- add: propose at most 3 new events that fill the detected gaps, with the interaction that should fire them.
- retire: destination/tag that double-counts or is redundant.
- P0 = correctness (double counting, consent), P1 = coverage, P2 = hygiene.
- At most 6 recommendations, each one plain sentence. At most 10 plan rows.`;

const PlanOutputSchema = z.object({
  recommendations: z.array(z.string()).max(8),
  plan: z
    .array(
      z.object({
        action: z.enum(["keep", "rename", "add", "deprecate", "retire"]),
        currentName: z.string().nullable(),
        proposedName: z.string(),
        destination: z.enum(["posthog", "ga4", "gtm", "gtag", "other"]),
        interaction: z.enum(["load", "click", "form_submit", "consent_toggle", "other"]),
        properties: z.array(z.string()).max(12),
        rationale: z.string(),
        evidenceIds: z.array(z.string()),
        priority: z.enum(["P0", "P1", "P2"]),
      }),
    )
    .max(12),
});

export interface SynthesizeInput {
  store: RunStore;
  site: string;
  runId: string;
  requestedUrl: string;
  pageBudget: number;
  pagesVisited: string[];
  pagesFailed: string[];
  startedAt: string;
  models: { crawler: string; synthesizer: string; reviewer: string; jev: string };
  env: Record<string, unknown>;
  sse: (event: string, data: Record<string, unknown>) => unknown;
  trace?: Trace;
  finishReason: string;
}

/** Deterministic events table from beacon evidence. */
export function buildEventRows(store: RunStore): EventRow[] {
  const evidence = store
    .listEvidence()
    .filter((e) => e.kind === "beacon" && typeof e.payload.eventName === "string");
  const groups = new Map<string, { eventName: string; interaction: string; destinations: Set<string>; pages: Set<string>; props: Set<string>; ids: string[] }>();
  for (const e of evidence) {
    const eventName = String(e.payload.eventName);
    const interaction = store.interactionFor(e);
    const key = `${eventName}::${interaction}`;
    let g = groups.get(key);
    if (!g) {
      g = { eventName, interaction, destinations: new Set<string>(), pages: new Set<string>(), props: new Set<string>(), ids: [] };
      groups.set(key, g);
    }
    if (e.dest) g.destinations.add(e.dest);
    g.pages.add(e.pageUrl);
    g.ids.push(e.id);
    const props = e.payload.props;
    if (props && typeof props === "object") {
      for (const k of Object.keys(props as Record<string, unknown>).slice(0, 20)) g.props.add(k);
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.eventName.localeCompare(b.eventName) || a.interaction.localeCompare(b.interaction))
    .map((g) => ({
      eventName: g.eventName,
      destinations: [...g.destinations].sort() as EventRow["destinations"],
      interaction: g.interaction as EventRow["interaction"],
      observedOn: [...g.pages].slice(0, 8),
      properties: [...g.props].slice(0, 10),
      evidenceIds: g.ids.slice(0, 10),
      notes: isReservedEventName(g.eventName) ? "platform auto-event (reserved name)" : undefined,
    }));
}

/** Deterministic tag inventory from snippet evidence. */
export function buildTagInventory(store: RunStore): TagInventoryItem[] {
  const evidence = store.listEvidence().filter((e) => e.kind === "snippet");
  const groups = new Map<string, { dest: string; srcs: Set<string>; pages: Set<string>; ids: string[]; details: Set<string> }>();
  for (const e of evidence) {
    const dest = e.dest ?? inferDest(e);
    const src = typeof e.payload.scriptSrc === "string" && e.payload.scriptSrc ? e.payload.scriptSrc : null;
    // Same tag loaded from several pages differs only by query params — group as one.
    const srcKey = src ? src.split("?")[0]! : "inline";
    const key = `${dest}::${srcKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { dest, srcs: new Set<string>(), pages: new Set<string>(), ids: [], details: new Set<string>() };
      groups.set(key, g);
    }
    if (src) g.srcs.add(srcKey);
    g.pages.add(e.pageUrl);
    g.ids.push(e.id);
    if (typeof e.payload.tagId === "string" && e.payload.tagId) g.details.add(e.payload.tagId);
    const initCalls = e.payload.initCalls;
    if (Array.isArray(initCalls)) {
      for (const call of initCalls.slice(0, 6)) {
        const text = String(call);
        const token = text.match(/api_key['"]?\s*[:=,]\s*['"]([A-Za-z0-9_-]{6,})['"]/)?.[1];
        const config = text.match(/gtag\s*\(\s*['"]config['"]\s*,\s*['"]([^'"]+)['"]/)?.[1];
        if (token) g.details.add(`posthog token ${token.slice(0, 10)}…`);
        if (config) g.details.add(config);
      }
    }
  }
  return [...groups.entries()]
    .map(([key, g]) => {
      const [dest] = key.split("::");
      const src = g.srcs.size > 0 ? [...g.srcs][0] : null;
      const host = src ? safeHost(src) : null;
      return {
        destination: dest as TagInventoryItem["destination"],
        injectedVia: src
          ? `script src${host ? ` (${host})` : ""}`
          : "inline <script> in page HTML",
        location:
          g.pages.size > 1 ? `site-wide (${g.pages.size} pages visited)` : [...g.pages][0] ?? "—",
        detail: g.details.size > 0 ? [...g.details].slice(0, 3).join(", ") : src ?? "inline snippet",
        evidenceIds: g.ids.slice(0, 8),
      };
    })
    .sort((a, b) => a.destination.localeCompare(b.destination));
}

function inferDest(e: Evidence): string {
  const src = typeof e.payload.scriptSrc === "string" ? e.payload.scriptSrc : JSON.stringify(e.payload);
  if (/GTM-|gtm\.js/i.test(src)) return "gtm";
  if (/G-[A-Z0-9]{6,}|gtag/i.test(src)) return "gtag";
  if (/posthog/i.test(src)) return "posthog";
  if (/google-analytics/i.test(src)) return "ga4";
  return "other";
}

/** Beacon destinations that prove a tag of this destination is sending. GTM is excluded: a container can be empty. */
const BEACON_DESTS: Record<string, string[]> = { posthog: ["posthog"], gtag: ["ga4", "gtag"], ga4: ["ga4", "gtag"] };

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
}

/** Hosts a tag evidence item points at: its script host and a "→ host" proxy target in tagId. */
function hostsOf(e: Evidence): string[] {
  const out: string[] = [];
  const src = typeof e.payload.scriptSrc === "string" ? safeHost(e.payload.scriptSrc) : null;
  if (src) out.push(src);
  const proxy = typeof e.payload.tagId === "string" ? e.payload.tagId.match(/→\s*(\S+)/)?.[1] : undefined;
  if (proxy) out.push(proxy);
  return out;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Deterministic gap detectors. Each gap cites evidence. */
export function buildGaps(store: RunStore, eventRows: EventRow[]): GapItem[] {
  const gaps: GapItem[] = [];
  const evidence = store.listEvidence();
  const consentEvidence = evidence.filter(
    (e) => e.kind === "dom" && ("consentBannerSelector" in e.payload || "consentApi" in e.payload),
  );
  const anyBanner = consentEvidence.some((e) => Boolean(e.payload.consentBannerSelector));
  const anyApi = consentEvidence.some((e) => Boolean(e.payload.consentApi));
  const beacons = evidence.filter((e) => e.kind === "beacon");

  // F10: a PostHog / GA tag is present but sent nothing. Say why when the browser told us.
  const diagEvidence = evidence.filter((e) => e.kind === "dom" && ("cspViolations" in e.payload || "failedAnalyticsRequests" in e.payload));
  const csp = diagEvidence.flatMap((e) => records(e.payload.cspViolations).map((v) => ({ id: e.id, uri: String(v.blockedUri), directive: String(v.directive) })));
  const failed = diagEvidence.flatMap((e) => records(e.payload.failedAnalyticsRequests).map((v) => ({ id: e.id, url: String(v.url), failure: String(v.failure) })));
  const silentGroups = new Set<string>();
  for (const tag of buildTagInventory(store)) {
    const sendsTo = BEACON_DESTS[tag.destination];
    if (!sendsTo || silentGroups.has(sendsTo.join())) continue;
    if (beacons.some((b) => b.dest && sendsTo.includes(b.dest))) continue;
    silentGroups.add(sendsTo.join());
    const tagEvidence = evidence.filter((e) => e.kind === "snippet" && tag.evidenceIds.includes(e.id));
    const hosts = new Set(tagEvidence.flatMap((e) => hostsOf(e)));
    const label = tag.destination === "posthog" ? "PostHog" : "Google Analytics";
    const relevant = (host: string | null) => Boolean(host) && (hosts.has(host!) || (tag.destination === "posthog" ? host!.includes("posthog") : /googletagmanager|google-analytics/.test(host!)));
    const blocked = csp.find((v) => relevant(safeHost(v.uri)));
    const failing = failed.find((v) => relevant(safeHost(v.url)));
    if (blocked) {
      gaps.push({
        title: "Analytics tag present but blocked by the site's Content-Security-Policy",
        severity: "high",
        detail: `The ${label} tag is in the page, but its Content-Security-Policy blocks ${blocked.uri} (${blocked.directive}), so the library never starts and no events are sent. Allow that host in script-src, and in connect-src for the ingestion host.`,
        evidenceIds: [...tag.evidenceIds.slice(0, 3), blocked.id],
      });
    } else if (failing) {
      gaps.push({
        title: "Analytics requests are failing",
        severity: "high",
        detail: `${label} requests are failing in the browser: ${failing.url} (${failing.failure}). Possible causes: an ad blocker, a network error, or CORS.`,
        evidenceIds: [...tag.evidenceIds.slice(0, 3), failing.id],
      });
    } else {
      gaps.push({
        title: "Analytics tag present but no events observed",
        severity: "medium",
        detail: `The ${label} tag was found but no analytics request was captured on the visited pages. Possible causes: events fire only after an interaction or consent, the library had not finished loading when the crawl moved on, or a block the crawler cannot see. Verify in a real browser.`,
        evidenceIds: tag.evidenceIds.slice(0, 3),
      });
    }
  }

  // The consent claim "beacons fire unconditionally" needs at least one beacon.
  if (consentEvidence.length > 0 && !anyApi && beacons.length > 0) {
    gaps.push({
      title: anyBanner ? "Consent banner present but no consent-mode integration observed" : "No consent-mode handling observed",
      severity: "high",
      detail: anyBanner
        ? "A consent banner renders, but no consent API (Google Consent Mode, TCF, Usercentrics) was observed on any visited page, so analytics beacons may fire before consent is granted."
        : "No consent banner and no consent API were observed on any visited page; analytics beacons fire unconditionally, which is a compliance risk for EU traffic.",
      evidenceIds: consentEvidence.slice(0, 5).map((e) => e.id),
    });
  }

  // Double counting: the same interaction feeding two destinations independently.
  const dual = eventRows.filter(
    (r) =>
      r.destinations.length >= 2 &&
      r.destinations.includes("posthog") &&
      (r.destinations.includes("ga4") || r.destinations.includes("gtag")),
  );
  if (dual.length > 0) {
    gaps.push({
      title: "Double counting risk: PostHog and GA4 fire independently for the same interaction",
      severity: "high",
      detail: `These interactions send events to both PostHog and GA4 through independent tags: ${dual
        .map((r) => `${r.eventName} (${r.interaction})`)
        .join("; ")}. Unless one is the system of record, counts will diverge or double.`,
      evidenceIds: dual.flatMap((r) => r.evidenceIds).slice(0, 6),
    });
  } else {
    const pageviewRows = eventRows.filter((r) =>
      r.eventName === "$pageview" || r.eventName === "page_view" || r.eventName === "first_visit" || r.eventName === "session_start",
    );
    const customRows = eventRows.filter((r) => !isReservedEventName(r.eventName));
    const bothFiring = pageviewRows.filter((r) => r.destinations.length >= 2).length > 0;
    if (bothFiring && customRows.length === 0) {
      gaps.push({
        title: "Pageview-only usage",
        severity: "medium",
        detail: "Only auto pageview events were observed on the wire — no custom events at all. Funnels and interaction analysis are impossible without custom events.",
        evidenceIds: pageviewRows.flatMap((r) => r.evidenceIds).slice(0, 6),
      });
    } else if (customRows.length === 0 && pageviewRows.length > 0) {
      gaps.push({
        title: "Pageview-only usage",
        severity: "medium",
        detail: "Only auto pageview events were observed on the wire across every visited page — no custom events at all.",
        evidenceIds: pageviewRows.flatMap((r) => r.evidenceIds).slice(0, 6),
      });
    }
  }

  // Duplicate/messy names for the same interaction (normalized equality).
  const byInteraction = new Map<string, EventRow[]>();
  for (const r of eventRows) {
    const list = byInteraction.get(r.interaction) ?? [];
    list.push(r);
    byInteraction.set(r.interaction, list);
  }
  const messy: string[] = [];
  const messyIds: string[] = [];
  for (const rows of byInteraction.values()) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i].eventName;
        const b = rows[j].eventName;
        if (a === b) continue;
        if (norm(a) === norm(b)) {
          messy.push(`${a} vs ${b}`);
          messyIds.push(...rows[i].evidenceIds.slice(0, 1), ...rows[j].evidenceIds.slice(0, 1));
        }
      }
    }
  }
  if (messy.length > 0) {
    gaps.push({
      title: "Duplicate/messy event names for the same interaction",
      severity: "medium",
      detail: `Different spellings of the same interaction were observed: ${messy.slice(0, 4).join("; ")}. Pick one convention spelling and deprecate the rest.`,
      evidenceIds: messyIds.slice(0, 6),
    });
  }

  // Events on the wire that look like cruft: very long or auto-generated names.
  const cruft = eventRows.filter((r) => r.eventName.length > 60 || /%|\s/.test(r.eventName));
  if (cruft.length > 0) {
    gaps.push({
      title: "Messy event names on the wire",
      severity: "low",
      detail: `Some event names contain spaces, percent-encoding, or are very long, which breaks reporting: ${cruft
        .slice(0, 4)
        .map((r) => r.eventName.slice(0, 60))
        .join("; ")}.`,
      evidenceIds: cruft.flatMap((r) => r.evidenceIds).slice(0, 6),
    });
  }

  return gaps;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface SynthResult {
  draft: Report;
  convention: DerivedConvention;
}

export async function synthesizeDraft(input: SynthesizeInput): Promise<SynthResult> {
  const { store } = input;
  const eventRows = buildEventRows(store);
  const tagInventory = buildTagInventory(store);
  const gaps = buildGaps(store, eventRows);
  const convention = deriveConvention(
    eventRows.map((r) => r.eventName),
    eventRows.flatMap((r) => r.properties),
  );
  input.sse("phase", { name: "synthesize", status: "assembling tables", events: eventRows.length, tags: tagInventory.length, gaps: gaps.length });

  // The single model step: the recommended tracking plan.
  const planInput = {
    convention: {
      eventStyle: convention.style,
      eventPattern: convention.eventPattern,
      propertyStyle: convention.propertyStyle,
      isDefault: convention.isDefault,
    },
    events: eventRows.map((r, i) => ({
      ref: eventRef(r.eventName, r.destinations.join("+")),
      eventName: r.eventName,
      destinations: r.destinations,
      interaction: r.interaction,
      properties: r.properties,
      evidenceIds: r.evidenceIds,
      notes: r.notes,
    })),
    gaps: gaps.map((g, i) => ({ ref: `gaps:${i}`, title: g.title, detail: g.detail, evidenceIds: g.evidenceIds })),
    evidence: store.digest(),
  };
  let plan: z.infer<typeof PlanOutputSchema> | null = null;
  let planError = "";
  const synthObs = input.trace?.startObservation({
    name: "synthesize-report",
    type: "agent",
    input: { events: eventRows.length, tags: tagInventory.length, gaps: gaps.length },
  });
  const planStartIso = new Date().toISOString();
  try {
    const res = await chatJsonParsed(
      input.env as never,
      {
        system: PLAN_SYSTEM,
        user: JSON.stringify(planInput),
        model: input.models.synthesizer,
        maxTokens: 2500,
      },
      PlanOutputSchema,
    );
    plan = res.value;
    if (input.trace && synthObs) {
      const gen = input.trace.startObservation({
        name: "propose-tracking-plan",
        type: "generation",
        parent: synthObs,
        model: input.models.synthesizer,
        input: planInput,
        startTime: planStartIso,
      });
      gen.end({
        output: assistantMessage({ content: JSON.stringify(res.value) }),
        usage: res.usage
          ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens, total: res.usage.total_tokens, cost: res.usage.cost }
          : undefined,
      });
    }
  } catch (e) {
    planError = String(e).slice(0, 300);
    if (input.trace && synthObs) {
      const gen = input.trace.startObservation({
        name: "propose-tracking-plan",
        type: "generation",
        parent: synthObs,
        model: input.models.synthesizer,
        input: planInput,
        startTime: planStartIso,
      });
      gen.end({ error: planError });
    }
    input.sse("phase", { name: "synthesize", status: "plan model step failed", error: planError });
  }
  synthObs?.end({ output: { plan: plan ? plan.plan.length : 0, recommendations: plan ? plan.recommendations.length : 0 } });

  const trackingPlan = plan ? validatePlan(plan.plan, eventRows, convention, store) : [];
  const recommendations = plan ? plan.recommendations.slice(0, 6) : [];
  if (planError && recommendations.length === 0) {
    recommendations.push(
      "The tracking plan model step failed; this report reflects only deterministically verified evidence. Re-run before adopting plan changes.",
    );
  }

  const draft: Report = {
    site: input.site,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    requestedUrl: input.requestedUrl,
    pageBudget: input.pageBudget,
    pagesVisited: input.pagesVisited,
    pagesFailed: input.pagesFailed,
    models: input.models,
    tagInventory,
    events: eventRows,
    convention: {
      style: convention.style,
      eventPattern: convention.eventPattern,
      propertyStyle: convention.propertyStyle,
      derivedFrom: convention.derivedFrom,
      confidence: convention.confidence,
      isDefault: convention.isDefault,
      ga4Note: convention.ga4Note,
    },
    gaps,
    recommendations,
    trackingPlan,
    jevRounds: [],
    contestedRefs: [],
    partial: false,
  };
  return { draft, convention };
}

/** Server-side validation of the model's plan rows (weak models get checked, not trusted). */
function validatePlan(
  rows: z.infer<typeof PlanOutputSchema>["plan"],
  eventRows: EventRow[],
  convention: DerivedConvention,
  store: RunStore,
): TrackingPlanRow[] {
  const knownEvidence = new Set(store.listEvidence().map((e) => e.id));
  const knownEvents = new Set(eventRows.map((r) => r.eventName));
  const out: TrackingPlanRow[] = [];
  for (const row of rows) {
    let { action, currentName, proposedName } = row;
    let notes = "";

    // Evidence: only existing IDs; fall back to the event row's evidence.
    let evidenceIds = row.evidenceIds.filter((id) => knownEvidence.has(id));
    if (evidenceIds.length === 0 && currentName && knownEvents.has(currentName)) {
      evidenceIds = eventRows.find((r) => r.eventName === currentName)?.evidenceIds.slice(0, 3) ?? [];
    }
    if (evidenceIds.length === 0) continue;

    // Reserved names are never renamed.
    if (currentName && isReservedEventName(currentName) && action === "rename") {
      action = "keep";
      proposedName = currentName;
      notes = "reserved platform event; rename not allowed";
    }

    // keep rows must be identical and exist.
    if (action === "keep") {
      if (!currentName || !knownEvents.has(currentName)) continue;
      proposedName = currentName;
    }
    // rename/deprecate/retire must reference a real observed event/tag.
    if ((action === "rename" || action === "deprecate") && (!currentName || !knownEvents.has(currentName))) {
      continue;
    }
    if (action === "retire" && destinationTagExists(row.destination, eventRows) === false && !knownEvents.has(currentName ?? "")) {
      continue;
    }
    // Convention enforcement for proposed names (with mechanical auto-fix).
    if (!isReservedEventName(proposedName) && !conformsTo(proposedName, convention.style)) {
      const fixed = toConvention(proposedName, convention.style);
      if (conformsTo(fixed, convention.style) && fixed !== currentName) {
        notes = `${notes ? notes + "; " : ""}proposedName auto-fixed to follow ${convention.style}`;
        proposedName = fixed;
      } else {
        notes = `${notes ? notes + "; " : ""}proposedName does not follow ${convention.style} and could not be auto-fixed`;
      }
    }
    // Diffable methods: rename must actually differ.
    if (action === "rename" && currentName === proposedName) {
      continue;
    }
    out.push({
      action,
      currentName: currentName ?? null,
      proposedName,
      destination: row.destination,
      interaction: row.interaction,
      properties: row.properties.slice(0, 10),
      rationale: (notes ? `${row.rationale} (${notes})` : row.rationale).slice(0, 300),
      evidenceIds: evidenceIds.slice(0, 6),
      priority: row.priority,
    });
  }
  return out.slice(0, 10);
}

function destinationTagExists(dest: string, eventRows: EventRow[]): boolean {
  return eventRows.some((r) => r.destinations.includes(dest as never));
}
