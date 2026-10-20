import type { Evidence, InteractionKind } from "../schemas/evidence";
import type { GapItem } from "../schemas/report";

/**
 * F11: the server owns every claim. Recommendations are templated from
 * deterministic gaps, `add` plan rows need evidence that the interaction exists,
 * and any URL a model writes must appear in captured (never model-authored) evidence.
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** One recommendation per gap remedy (server-written), highest severity first, deduplicated, at most 6. */
export function recommendationsFromGaps(gaps: GapItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of [...gaps].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
    if (!g.remedy || seen.has(g.remedy)) continue;
    seen.add(g.remedy);
    out.push(`${g.remedy} (${g.evidenceIds.slice(0, 3).join(", ")})`);
  }
  return out.slice(0, 6);
}

export interface Corpus {
  /** Everything captured: page URLs and payloads. */
  all: string;
  /** Only what the browser reported as blocked or failed. */
  blocked: string;
}

/** Text a claim may be checked against. Crawler-authored (source "model") evidence is excluded. */
export function evidenceCorpus(evidence: Evidence[]): Corpus {
  const captured = evidence.filter((e) => e.source === "capture");
  return {
    all: captured.map((e) => `${e.pageUrl} ${JSON.stringify(e.payload)}`).join("\n"),
    blocked: captured
      .map((e) => `${JSON.stringify(e.payload.cspViolations ?? [])} ${JSON.stringify(e.payload.failedAnalyticsRequests ?? [])}`)
      .join("\n"),
  };
}

const URL_TOKEN = /https?:\/\/[^\s"'`)<>,]+/g;
const FILE_TOKEN = /[\w.-]+\.js\b/g;
const BLOCK_CONTEXT = /\bblock|content[- ]security|\bcsp\b|script-src|connect-src/i;

/** Returns the first URL or script file named in `text` that the evidence does not support, else null. */
export function lintClaim(text: string, corpus: Corpus): string | null {
  for (const sentence of text.split(/(?<=[.;!?])\s+(?=[A-Z])/)) {
    const haystack = BLOCK_CONTEXT.test(sentence) ? corpus.blocked : corpus.all;
    const urls = (sentence.match(URL_TOKEN) ?? []).map((t) => t.replace(/[.,;:]+$/, ""));
    const files = (sentence.replace(URL_TOKEN, " ").match(FILE_TOKEN) ?? []).map((t) => t.replace(/^[.-]+/, ""));
    for (const token of [...urls, ...files]) {
      if (!haystack.includes(token)) return token;
    }
  }
  return null;
}

/** An `add` row for this interaction must be backed by captured evidence that the interaction exists.
 * Only click, form_submit and consent_toggle can be proven; anything else is not admissible. */
export function addAdmissible(interaction: InteractionKind, evidence: Evidence[]): boolean {
  const captured = evidence.filter((e) => e.source === "capture");
  const probed = (name: string) =>
    captured.some((e) => e.payload.probe === true && e.payload.interaction === name && e.payload.found === true);
  switch (interaction) {
    case "click":
      return probed("cta_click");
    case "form_submit":
      return probed("form_submit");
    case "consent_toggle":
      return captured.some((e) => typeof e.payload.consentBannerSelector === "string" && e.payload.consentBannerSelector !== "");
    default:
      // load/other: a new event cannot be justified by an interaction nobody probed.
      return false;
  }
}

/** Evidence payload for one scripted interaction attempt, stored even when no beacon fired. */
export function interactionProbePayload(preset: string, detail: string, beaconsFired: number, stepId: string): Record<string, unknown> {
  return {
    probe: true,
    interaction: preset,
    detail,
    found: !/^(no |unknown preset|interaction error)/i.test(detail),
    beaconsFired,
    stepId,
    note: "interaction attempt",
  };
}
