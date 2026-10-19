import { loadAgentConfig, resolveModels } from "./config";
import { jevGradeCritique, JevUnavailableError } from "./jev";
import type { BrowserWorker } from "@cloudflare/playwright";
import { BrowserPool } from "./browser/driver";
import { CaptureCollector } from "./browser/pageTools";
import { runCrawl, type CrawlShared } from "./pipeline/crawl";
import { adversarialReview } from "./pipeline/review";
import { applyCritiques, roundCritiqueRows } from "./pipeline/revise";
import { finalGate } from "./pipeline/gate";
import { renderMarkdown } from "./pipeline/render";
import { buildEventRows, buildTagInventory, synthesizeDraft } from "./pipeline/synthesize";
import { deriveConvention } from "./pipeline/convention";
import { RunRequestSchema } from "./schemas/run";
import type { Critique, Report, RoundLog } from "./schemas/report";
import { RunStore, SCHEMA_SQL } from "./store";
import { Trace } from "./trace";

/**
 * One agent run, streamed as server-sent events from the Durable Object.
 * Phases: crawl (tool-stepping loop) -> synthesize -> [adversarial review ->
 * Jev grade -> revise] x N rounds -> final gate -> markdown report.
 * Budgets exhaust into a partial-evidence error report — never fabrication.
 */

export interface RunAgent {
  ctx: DurableObjectState;
  env: Env;
}

const encoder = new TextEncoder();

type SseWriter = WritableStreamDefaultWriter<Uint8Array>;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Ensure the SQLite schema exists for this agent instance. */
export function ensureSchema(agent: RunAgent): void {
  agent.ctx.blockConcurrencyWhile(async () => {
    for (const stmt of SCHEMA_SQL.split(";")) {
      const trimmed = stmt.trim();
      if (trimmed) agent.ctx.storage.sql.exec(trimmed);
    }
  });
}

/** POST /run — validate the body, stream the run as SSE. */
export async function handleRun(
  agent: RunAgent,
  request: Request,
  onPipeline?: (pipeline: Promise<void>) => void,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body; expected { url, pageBudget? }", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) },
      { status: 400 },
    );
  }
  const runId = request.headers.get("x-run-id") ?? crypto.randomUUID();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pipeline = runPipeline(agent, parsed.data, runId, writer, new URL(request.url).hostname)
    .catch(async (e) => {
      await safeWrite(writer, "error", { message: String(e).slice(0, 300) });
    })
    .finally(async () => {
      await writer.close().catch(() => {});
    });

  // The DO stays alive while the stream is open and the pipeline is
  // referenced (the agent registers it in activeWork).
  onPipeline?.(pipeline);
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-run-id": runId,
    },
  });
}

/** GET /runs/:id/report(.md) — the persisted report of a finished run. */
export async function handleGetReport(agent: RunAgent, format: "json" | "md"): Promise<Response> {
  ensureSchema(agent);
  const store = new RunStore(sqlExec(agent), agent.ctx.id.name ?? "unknown", "");
  const report = store.getReport();
  if (!report) return new Response("No report for this run id yet", { status: 404 });
  return format === "md"
    ? new Response(report.markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } })
    : new Response(report.json, { headers: { "content-type": "application/json; charset=utf-8" } });
}

async function runPipeline(
  agent: RunAgent,
  input: { url: string; pageBudget?: number },
  runId: string,
  writer: SseWriter,
  requestOrigin: string,
): Promise<void> {
  ensureSchema(agent);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const cfg = loadAgentConfig(agent.env.AGENT_CONFIG);
  const models = resolveModels(agent.env);
  const url = new URL(input.url).toString();
  const site = new URL(url).hostname;
  const pageBudget = Math.min(input.pageBudget ?? cfg.pageBudgetDefault, cfg.pageBudgetMax);
  const deadline = started + cfg.wallClockCapMs;

  const sse = (event: string, data: Record<string, unknown>) => safeWrite(writer, event, { runId, ...data });
  const log = (m: string) => console.log(`[run ${runId}] ${m}`);

  const store = new RunStore(sqlExec(agent), runId, site);
  store.log("run_started", { url, pageBudget });
  // Langfuse: one trace per run; sessions group runs against the same site;
  // local dev runs are marked development so they don't pollute production views.
  const trace = new Trace(runId, "analytics-audit", { url, pageBudget }, {
    sessionId: site,
    environment: /localhost|127\.0\.0\.1/.test(requestOrigin) ? "development" : "production",
    tags: ["analytics-audit"],
  });

  const partialReport = async (error: string, budgetExhausted: boolean): Promise<Report> => ({
    site,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    requestedUrl: url,
    pageBudget,
    pagesVisited: [],
    pagesFailed: [],
    models: { crawler: models.crawler, synthesizer: models.synthesizer, reviewer: models.reviewer, jev: models.jevModel },
    tagInventory: [],
    events: [],
    convention: {
      style: "none_discernible",
      eventPattern: "default object_action snake_case (no evidence gathered)",
      propertyStyle: "snake",
      derivedFrom: "no evidence; the run failed before synthesis",
      confidence: 0,
      isDefault: true,
      ga4Note: "GA4 is terminology-locked.",
    },
    gaps: [],
    recommendations: [],
    trackingPlan: [],
    jevRounds: [],
    contestedRefs: [],
    partial: true,
    budgetExhausted: budgetExhausted,
    error,
  });

  sse("run_started", { site, url, pageBudget, wallClockCapMs: cfg.wallClockCapMs, models: { crawler: models.crawler, reviewer: models.reviewer, jev: models.jevModel } });

  // ---------------- Phase 1: crawl (Agents SDK tool-stepping loop) ----------------
  sse("phase", { name: "crawl", status: "started" });
  // The generated Env infers the binding as cf/config's BrowserRun type; the
  // runtime surface is @cloudflare/playwright's BrowserWorker.
  const browserBinding = (agent.env as { BROWSER?: unknown }).BROWSER as BrowserWorker | undefined;
  const pool = new BrowserPool(browserBinding, cfg.crawlParallelism, log);
  const shared: CrawlShared = {
    store,
    cfg,
    pool,
    collector: new CaptureCollector(),
    deadline,
    site,
    url,
    pageBudget,
    pages: [],
    pageStates: new Map(),
    current: null,
    interactionSeq: 0,
    finished: false,
    finishReason: "",
    sse,
    env: agent.env as unknown as Record<string, unknown>,
    crawlerModel: models.crawler,
    trace,
    crawlObs: trace.startObservation({ name: "crawl-site", type: "agent", input: { url, pageBudget } }),
  };

  let crawlSummary: Awaited<ReturnType<typeof runCrawl>>;
  try {
    crawlSummary = await runCrawl(shared);
  } finally {
    await pool.close().catch(() => {});
  }
  const budgetExhausted = crawlSummary.finishReason.startsWith("server-finalized") || Date.now() > deadline;
  shared.crawlObs.end({ output: { ...crawlSummary } });
  sse("phase", { name: "crawl", status: "done", pagesVisited: crawlSummary.pagesVisited.length, pagesFailed: crawlSummary.pagesFailed.length, evidenceCount: crawlSummary.evidenceCount });

  // ---------------- Phases 2-4: synthesize -> validate -> gate ----------------
  // Any crash here hard-stops into a partial-evidence error report — never fabrication.
  let report: Report;
  let gateNotes: string[] = [];
  try {
    sse("phase", { name: "synthesize", status: "started" });
    const { draft } = await synthesizeDraft({
      store,
      site,
      runId,
      requestedUrl: url,
      pageBudget,
      pagesVisited: crawlSummary.pagesVisited,
      pagesFailed: crawlSummary.pagesFailed,
      startedAt,
      models: { crawler: models.crawler, synthesizer: models.synthesizer, reviewer: models.reviewer, jev: models.jevModel },
      env: agent.env as unknown as Record<string, unknown>,
      sse,
      trace,
      finishReason: crawlSummary.finishReason,
    });
    draft.partial = budgetExhausted;
    draft.budgetExhausted = budgetExhausted || undefined;
    sse("draft_ready", { events: draft.events.length, tags: draft.tagInventory.length, gaps: draft.gaps.length, plan: draft.trackingPlan.length });

    // ---------------- Validation loop ----------------
    sse("phase", { name: "validate", status: "started", maxRounds: cfg.maxValidationRounds });
    const rounds: RoundLog[] = [];
    let validationError: string | null = null;
    for (let round = 1; round <= cfg.maxValidationRounds; round++) {
      if (Date.now() > deadline) {
        validationError = "wall-clock budget exhausted during validation";
        draft.partial = true;
        break;
      }
      let critiques: Critique[];
      const roundObs = trace.startObservation({ name: "review-draft", type: "agent", input: { round }, metadata: { round } });
      try {
        critiques = await adversarialReview(agent.env as unknown as Record<string, unknown>, models.reviewer, draft, store, sse, trace, roundObs, round);
      } catch (e) {
        roundObs.end({ error: `adversarial review failed: ${String(e).slice(0, 160)}` });
        validationError = `adversarial review failed: ${String(e).slice(0, 200)}`;
        break;
      }
      for (const c of critiques) {
        sse("critique", { id: c.id, type: c.type, targetRef: c.targetRef, claim: c.claim.slice(0, 200), citedEvidenceIds: c.citedEvidenceIds });
      }
      if (critiques.length === 0) {
        rounds.push({ round, critiqueCount: 0, propagated: 0, critiques: [] });
        break;
      }
      const gradings = new Map<string, Awaited<ReturnType<typeof jevGradeCritique>>>();
      let jevFailed: string | null = null;
      for (const c of critiques) {
        try {
          const grading = await jevGradeCritique(
            agent.env,
            {
              critiqueId: c.id,
              critique: c.claim,
              draftStatement: draftStatementFor(draft, c),
              citedEvidence: store.evidenceByIds(c.citedEvidenceIds).map((e) => compactEvidence(e)),
              model: models.jevModel,
              apiUrl: models.jevApiUrl,
            },
            (info) => store.log("jev_attempt", { critiqueId: c.id, attempt: info.attempt, ...(info.error ? { error: info.error } : {}) }),
            roundObs,
          );
          gradings.set(c.id, grading);
          sse("jev_verdict", {
            critiqueId: c.id,
            verdict: grading.verdict,
            confidence: grading.confidence,
            flagged: grading.flagged,
            propagated: grading.verdict === "Correct",
          });
        } catch (e) {
          if (e instanceof JevUnavailableError) {
            jevFailed = e.message;
            break;
          }
          throw e;
        }
      }
      if (jevFailed) {
        validationError = `Jev adjudication unavailable: ${jevFailed}. Critiques were NOT graded; none propagated; affected items ship ungraded (see appendix).`;
        rounds.push({
          round,
          critiqueCount: critiques.length,
          propagated: 0,
          critiques: roundCritiqueRows(critiques, gradings),
        });
        roundObs.end({ error: jevFailed, output: { critiqueCount: critiques.length, propagated: 0 } });
        break;
      }
      const correct = critiques.filter((c) => gradings.get(c.id)?.verdict === "Correct");
      rounds.push({
        round,
        critiqueCount: critiques.length,
        propagated: correct.length,
        critiques: roundCritiqueRows(critiques, gradings),
      });
      sse("round_summary", { round, critiques: critiques.length, propagated: correct.length });
      roundObs.end({ output: { critiqueCount: critiques.length, propagated: correct.length } });
      if (correct.length === 0) break;
      const outcome = applyCritiques(draft, correct, store);
      Object.assign(draft, outcome.revised);
      sse("revised", { applied: outcome.applied.length, contested: outcome.contested.length, appliedFixes: outcome.applied });
    }
    draft.jevRounds = rounds;
    if (validationError) {
      draft.partial = true;
      draft.error = validationError;
    }
    sse("phase", { name: "validate", status: "done", rounds: rounds.length });

    // ---------------- Final gate ----------------
    sse("phase", { name: "gate", status: "checking" });
    const gated = finalGate(draft, store);
    report = gated.report;
    gateNotes = gated.notes;
  } catch (e) {
    // Hard-stop with a partial-evidence error report: deterministic tables
    // from the evidence gathered so far; no model calls, no fabrication.
    report = await partialReport(`run failed after the crawl: ${String(e).slice(0, 240)}`, Date.now() > deadline);
    report.pagesVisited = crawlSummary.pagesVisited;
    report.pagesFailed = crawlSummary.pagesFailed;
    report.events = buildEventRows(store);
    report.tagInventory = buildTagInventory(store);
    const derived = deriveConvention(
      report.events.map((r) => r.eventName),
      report.events.flatMap((r) => r.properties),
    );
    report.convention = { ...derived };
    trace.end({ error: String(e).slice(0, 240), partial: true }, { site, evidenceCount: store.listEvidence().length });
    await trace.flush(agent.env);
    sse("phase", { name: "gate", status: "failed-partial" });
  }
  if (gateNotes.length > 0) {
    store.log("gate_notes", gateNotes);
    sse("gate_notes", { notes: gateNotes });
  }
  const markdown = renderMarkdown(report);
  store.persistReport(markdown, JSON.stringify(report));
  trace.end(
    { sections: { tags: report.tagInventory.length, events: report.events.length, gaps: report.gaps.length, plan: report.trackingPlan.length }, partial: report.partial },
    { site, evidenceCount: store.listEvidence().length, pagesVisited: report.pagesVisited.length, tookMs: Date.now() - started, report_markdown: markdown },
  );
  await trace.flush(agent.env);
  if (trace.ingest) sse("trace", trace.ingest);
  sse("report", { markdown, report });
  store.log("run_finished", { partial: report.partial, evidence: store.listEvidence().length });
  sse("done", { runId, partial: report.partial, evidenceCount: store.listEvidence().length, tookMs: Date.now() - started });
}

function draftStatementFor(draft: Report, critique: Critique): string {
  const [kind, rest] = [critique.targetRef.slice(0, critique.targetRef.indexOf(":")), critique.targetRef.slice(critique.targetRef.indexOf(":") + 1)];
  if (kind === "events") {
    const name = rest.slice(0, rest.indexOf("@")) || rest;
    const rows = draft.events.filter((r) => r.eventName === name);
    return rows.length > 0 ? JSON.stringify(rows.map((r) => ({ eventName: r.eventName, destinations: r.destinations, interaction: r.interaction, evidenceIds: r.evidenceIds }))) : `no event row named ${name}`;
  }
  if (kind === "gaps" || kind === "plan" || kind === "tags") {
    const i = Number(rest);
    const rows = kind === "gaps" ? draft.gaps : kind === "plan" ? draft.trackingPlan : draft.tagInventory;
    const row = rows[i];
    return row ? JSON.stringify(row) : `no ${kind} row ${i}`;
  }
  if (kind === "convention") {
    return JSON.stringify(draft.convention);
  }
  return "unresolved target";
}

function compactEvidence(e: { id: string; pageUrl: string; kind: string; payload: Record<string, unknown> }): Record<string, unknown> {
  return { id: e.id, pageUrl: e.pageUrl, kind: e.kind, payload: e.payload };
}

function sqlExec(agent: RunAgent): { exec: (query: string, ...params: (string | number | null)[]) => { toArray: () => Record<string, unknown>[]; one: () => Record<string, unknown> } } {
  return {
    exec: (query: string, ...params: (string | number | null)[]) => agent.ctx.storage.sql.exec(query, ...params),
  };
}

async function safeWrite(writer: SseWriter, event: string, data: Record<string, unknown>): Promise<void> {
  const payload = `data: ${JSON.stringify({ event, ts: new Date().toISOString(), ...data })}\n\n`;
  try {
    await writer.write(encoder.encode(payload));
  } catch {
    /* client disconnected; the run continues so the report is persisted */
  }
}
