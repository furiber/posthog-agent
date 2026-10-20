import { streamText, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { AgentConfig } from "../config";
import { LOW_EFFORT_PROVIDER_OPTIONS, ModelCallError, loopModel } from "../models";
import type { BrowserPool, PageSession } from "../browser/driver";
import { beaconEvidencePayload, parsePostHogInit } from "../browser/capture";
import {
  CaptureCollector,
  fireInteraction,
  inspectDom,
  openPage,
} from "../browser/pageTools";
import type { CapturedRequest } from "../schemas/evidence";
import type { RunStore } from "../store";
import { discoverPages } from "./sitemap";
import { assistantMessage, type Observation, type Trace } from "../trace";

/**
 * Crawler agent: the Agents SDK tool-stepping loop (streamText + tools).
 * The model is weak and cheap on purpose — the reliability comes from the
 * mechanical procedure below and the deterministic tools, not model
 * intelligence. Tools never throw: failures return structured errors the
 * model can act on, and every failing/invalid step is retried within the
 * attempt budget (4, or 8 for pages that fail to render or are complex).
 */

export interface PageState {
  steps: number;
  attempts: number;
  complex: boolean;
  visited: boolean;
  failed: boolean;
  beacons: number;
  evidenceIds: string[];
}

export interface CrawlShared {
  store: RunStore;
  cfg: AgentConfig;
  pool: BrowserPool;
  collector: CaptureCollector;
  deadline: number;
  site: string;
  url: string;
  pageBudget: number;
  pages: string[];
  pageStates: Map<string, PageState>;
  current: { url: string; session: PageSession; complex: boolean } | null;
  interactionSeq: number;
  finished: boolean;
  finishReason: string;
  sse: (event: string, data: Record<string, unknown>) => unknown;
  env: Record<string, unknown>;
  crawlerModel: string;
  trace: Trace;
  crawlObs: Observation;
}

export interface CrawlSummary {
  finished: boolean;
  finishReason: string;
  pagesVisited: string[];
  pagesFailed: string[];
  evidenceCount: number;
  restarts: number;
}

const SYSTEM = `You are the crawler of an analytics instrumentation audit. You drive a browser only through tools.

STRICT PROCEDURE — follow it exactly, one tool call at a time:
1. Call sitemap_discover once with the site URL and the page budget.
2. For each URL in the returned pages list, in order, do exactly this:
   a. load_page(url)
   b. inspect_dom()
   c. interact with preset "consent_toggle" — only on the FIRST page
   d. interact with preset "cta_click"
   e. interact with preset "form_submit" — only if a form was seen in this page's results; otherwise skip it
   f. load_page the next URL
3. When every listed URL is done, or a tool result says the budget is exhausted or a page failed twice, call finish_crawl with a one-line reason.

RULES:
- Everything you know comes from tool results. Never invent events, URLs, or evidence.
- If a tool returns an error, follow its instruction (move to the next page, or finish). Do not repeat a failed call more than once.
- Do not call any tool after finish_crawl.
- If you notice something about the page's analytics worth remembering (for example a consent banner, a duplicate event, an odd tag), call record_evidence with a short note.`;

function freshPageState(): PageState {
  return { steps: 0, attempts: 0, complex: false, visited: false, failed: false, beacons: 0, evidenceIds: [] };
}

function stateFor(shared: CrawlShared, url: string): PageState {
  let s = shared.pageStates.get(url);
  if (!s) {
    s = freshPageState();
    shared.pageStates.set(url, s);
  }
  return s;
}

function wallClockGuard(shared: CrawlShared): { error: string; mustFinish: true } | null {
  if (Date.now() > shared.deadline) {
    return { error: "wall-clock budget exhausted; call finish_crawl now", mustFinish: true };
  }
  return null;
}

/** Record captured requests as evidence; returns the new evidence IDs. */
function recordCaptures(shared: CrawlShared, captures: CapturedRequest[], pageUrl: string, interactionStepId?: string): string[] {
  const ids: string[] = [];
  for (const capture of captures) {
    const c = capture.classified;
    if (c.kind === "script") {
      const e = shared.store.appendEvidence({
        pageUrl,
        timestamp: capture.timestamp,
        kind: "snippet",
        source: "capture",
        dest: c.dest,
        captureId: `S:${capture.captureId}`,
        payload: { scriptSrc: c.src, tagId: c.tagId ?? null, note: "tag script load observed on the wire" },
      });
      if (e) ids.push(e.id);
      continue;
    }
    if (c.events.length === 0) {
      const e = shared.store.appendEvidence({
        pageUrl,
        timestamp: capture.timestamp,
        kind: "beacon",
        source: "capture",
        dest: c.dest,
        captureId: `S:${capture.captureId}`,
        interactionStepId,
        payload: { ...beaconEvidencePayload(capture), note: "analytics endpoint hit with no parsed events (config endpoint)" },
      });
      if (e) ids.push(e.id);
      continue;
    }
    c.events.forEach((ev, i) => {
      const e = shared.store.appendEvidence({
        pageUrl,
        timestamp: capture.timestamp,
        kind: "beacon",
        source: "capture",
        dest: c.kind === "beacon" ? c.dest : ev.dest,
        captureId: `S:${capture.captureId}:${i}`,
        interactionStepId,
        payload: {
          ...beaconEvidencePayload(capture),
          eventName: ev.eventName,
          props: ev.props,
          requestUrl: capture.requestUrl.split("?")[0],
        },
      });
      if (e) ids.push(e.id);
    });
  }
  if (ids.length > 0) shared.sse("evidence", { added: ids.length, total: shared.store.listEvidence().length });
  return ids;
}

/** Retry wrapper: any failing tool step may be retried (4; 8 for complex pages). */
async function withAttempts<T extends object>(
  shared: CrawlShared,
  url: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T | { error: string; moveOn?: boolean; mustFinish?: boolean }> {
  const state = stateFor(shared, url);
  const limit = state.complex || state.failed ? shared.cfg.complexToolAttemptLimit : shared.cfg.toolAttemptLimit;
  let lastError = "";
  for (let attempt = 1; attempt <= limit; attempt++) {
    state.attempts += 1;
    shared.sse("tool_step", { tool: label, url, attempt, status: attempt === 1 ? "run" : "retry" });
    shared.store.log("tool_attempt", { tool: label, url, attempt });
    try {
      const out = await fn();
      shared.sse("tool_step", { tool: label, url, attempt, status: "ok" });
      return out;
    } catch (e) {
      lastError = String(e).slice(0, 200);
      shared.sse("tool_step", { tool: label, url, attempt, status: "error", error: lastError });
      if (Date.now() > shared.deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 4000)));
    }
  }
  state.failed = true;
  shared.store.log("tool_failed", { tool: label, url, attempts: limit, error: lastError });
  shared.sse("tool_step", { tool: label, url, status: "failed", attempts: limit, error: lastError });
  return {
    error: `${label} failed after ${limit} attempts: ${lastError}. Mark the page failed and move to the next page.`,
    moveOn: true,
  };
}

async function closeCurrent(shared: CrawlShared): Promise<void> {
  if (shared.current) {
    await shared.current.session.close().catch(() => {});
    shared.current = null;
  }
}

/** The five crawler tools (record_evidence included). */
function buildTools(shared: CrawlShared) {
  return {
    sitemap_discover: tool({
      description:
        "Read sitemap.xml (falls back to link discovery) and return the list of page URLs to visit, capped at the page budget. Call this exactly once, first.",
      inputSchema: z.object({
        url: z.string().describe("The site's entry URL"),
        pageBudget: z.number().int().optional().describe("Max pages to visit; omit to use the run's budget"),
      }),
      execute: async ({ url, pageBudget }) => {
        const guard = wallClockGuard(shared);
        if (guard) return guard;
        if (shared.pages.length > 0) {
          return {
            pages: shared.pages,
            source: "cached",
            note: "Discovery already ran. Continue with the next unvisited page in the list.",
          };
        }
        const budget = Math.min(pageBudget ?? shared.pageBudget, shared.cfg.pageBudgetMax);
        const result = await discoverPages(url, budget, (m) => shared.store.log("discover", m));
        shared.pages = result.pages;
        for (const p of result.pages) stateFor(shared, p);
        shared.sse("discovered", { pages: result.pages.length, source: result.source, truncated: result.truncated });
        shared.store.log("discovered", { count: result.pages.length, source: result.source, truncated: result.truncated });
        return {
          pages: result.pages,
          source: result.source,
          truncated: result.truncated,
          note: `Visit the URLs one at a time, in order. Budget: ${budget} pages. truncated means more URLs exist than the budget allows.`,
        };
      },
    }),

    load_page: tool({
      description:
        "Navigate to a URL, wait for it to settle, and capture every analytics beacon the page fires on load (PostHog, GA4, GTM, gtag). Only the latest loaded page stays open for inspect_dom and interact.",
      inputSchema: z.object({ url: z.string().describe("Page URL from the pages list") }),
      execute: async ({ url }) => {
        const guard = wallClockGuard(shared);
        if (guard) return guard;
        const state = stateFor(shared, url);
        if (state.visited && !state.failed) {
          return { ok: true, url, note: "already visited", evidenceIds: state.evidenceIds };
        }
        if (state.steps >= shared.cfg.maxToolStepsPerPage) {
          return { error: `step budget for this page is exhausted (${shared.cfg.maxToolStepsPerPage}); move to the next page`, moveOn: true };
        }
        const out = await withAttempts(shared, url, "load_page", async () => {
          await closeCurrent(shared);
          return openPage(shared.pool, url, shared.collector);
        });
        if ("error" in out) return out;
        state.visited = true;
        state.complex = out.complex;
        shared.current = { url, session: out.session, complex: out.complex };
        state.steps += 1;
        const ids = recordCaptures(shared, out.loadCaptures, url);
        state.evidenceIds.push(...ids);
        state.beacons += ids.length;
        shared.sse("page", {
          url,
          status: "ok",
          complex: out.complex,
          beacons: ids.length,
          evidenceIds: ids,
          stepsUsed: state.steps,
          tookMs: out.tookMs,
        });
        shared.store.log("page_visited", { url, complex: out.complex, evidence: ids.length });
        const beaconSummary = out.loadCaptures
          .flatMap((c) => (c.classified.kind === "beacon" ? c.classified.events : []))
          .slice(0, 12)
          .map((e) => ({ dest: e.dest, eventName: e.eventName }));
        return {
          ok: true,
          url,
          finalUrl: out.finalUrl,
          title: out.title,
          complex: out.complex,
          beacons: beaconSummary,
          evidenceIds: ids,
          stepsUsed: state.steps,
          next: "call inspect_dom for this page",
        };
      },
    }),

    inspect_dom: tool({
      description:
        "Inspect the currently loaded page: analytics tag scripts, init/config calls (posthog.init, gtag config, dataLayer), dataLayer contents, and consent-banner state. Run it right after load_page.",
      inputSchema: z.object({}),
      execute: async () => {
        const guard = wallClockGuard(shared);
        if (guard) return guard;
        if (!shared.current) {
          return { error: "no page is loaded; call load_page first" };
        }
        const url = shared.current.url;
        const state = stateFor(shared, url);
        if (state.steps >= shared.cfg.maxToolStepsPerPage) {
          return { error: `step budget for this page is exhausted; move to the next page`, moveOn: true };
        }
        const out = await withAttempts(shared, url, "inspect_dom", async () => inspectDom(shared.current!.session.page));
        if ("error" in out) return out;
        state.steps += 1;
        const ids: string[] = [];
        for (const s of out.scripts) {
          const e = shared.store.appendEvidence({
            pageUrl: url,
            timestamp: new Date().toISOString(),
            kind: "snippet",
            source: "capture",
            captureId: `D:${url}:${s.src ?? s.note.slice(0, 40)}`,
            payload: { scriptSrc: s.src ?? null, inline: s.src ? null : s.note, note: "tag script found in DOM" },
          });
          if (e) ids.push(e.id);
        }
        // PostHog behind a renamed first-party loader: tag evidence from the script
        // body, and learn the ingestion host so proxied beacons classify as PostHog.
        for (const s of out.posthogInitScripts) {
          const init = parsePostHogInit(s.snippet);
          shared.collector.learnHost(init?.apiHost);
          const e = shared.store.appendEvidence({
            pageUrl: url,
            timestamp: new Date().toISOString(),
            kind: "snippet",
            source: "capture",
            dest: "posthog",
            captureId: `D:${url}:phinit:${s.src}`,
            payload: {
              scriptSrc: s.src,
              tagId: init ? `${init.tokenMasked}${init.apiHost ? ` → ${init.apiHost}` : ""}` : null,
              note: "posthog.init found in script body",
            },
          });
          if (e) ids.push(e.id);
        }
        try {
          if (out.posthogRuntime?.apiHost) shared.collector.learnHost(new URL(out.posthogRuntime.apiHost).hostname);
        } catch {
          /* relative or malformed api_host: ignore */
        }
        if (out.initCalls.length > 0) {
          const e = shared.store.appendEvidence({
            pageUrl: url,
            timestamp: new Date().toISOString(),
            kind: "snippet",
            source: "capture",
            captureId: `D:${url}:init`,
            payload: { initCalls: out.initCalls, note: "analytics init/config calls in inline scripts" },
          });
          if (e) ids.push(e.id);
        }
        if (out.dataLayer) {
          const e = shared.store.appendEvidence({
            pageUrl: url,
            timestamp: new Date().toISOString(),
            kind: "dom",
            source: "capture",
            captureId: `D:${url}:dl`,
            payload: { dataLayer: out.dataLayer, note: "dataLayer contents" },
          });
          if (e) ids.push(e.id);
        }
        const consentEvidence = shared.store.appendEvidence({
          pageUrl: url,
          timestamp: new Date().toISOString(),
          kind: "dom",
          source: "capture",
          captureId: `D:${url}:consent`,
          payload: {
            consentBannerSelector: out.consent.banner,
            consentApi: out.consent.api,
            note: out.consent.banner ? "consent banner present in DOM" : "no consent banner found in DOM",
          },
        });
        if (consentEvidence) ids.push(consentEvidence.id);
        const diag = shared.collector.diagnosticsFor(url);
        if (diag.cspViolations.length > 0 || diag.failedAnalyticsRequests.length > 0) {
          const e = shared.store.appendEvidence({
            pageUrl: url,
            timestamp: new Date().toISOString(),
            kind: "dom",
            source: "capture",
            captureId: `D:${url}:diag`,
            payload: { ...diag, note: "console CSP errors and failed analytics requests" },
          });
          if (e) ids.push(e.id);
        }
        state.evidenceIds.push(...ids);
        shared.sse("tool_step", { tool: "inspect_dom", url, status: "ok", evidence: ids.length });
        return {
          ok: true,
          url,
          title: out.title,
          scripts: out.scripts.length,
          initCalls: out.initCalls.length,
          dataLayerEntries: out.dataLayer?.length ?? 0,
          consent: out.consent,
          evidenceIds: ids,
          stepsUsed: state.steps,
        };
      },
    }),

    interact: tool({
      description:
        "Fire a scripted interaction on the currently loaded page and capture the analytics events it fires. Presets: cta_click (click a visible CTA), consent_toggle (accept the consent banner), form_submit (fill a non-honeypot test form and submit it).",
      inputSchema: z
        .object({
          preset: z.enum(["cta_click", "consent_toggle", "form_submit"]).optional(),
          selector: z.string().optional().describe("CSS selector to click instead of a preset"),
        })
        .refine((v) => v.preset !== undefined || v.selector !== undefined, {
          message: "provide preset or selector",
        }),
      execute: async ({ preset, selector }) => {
        const guard = wallClockGuard(shared);
        if (guard) return guard;
        if (!shared.current) {
          return { error: "no page is loaded; call load_page first" };
        }
        const url = shared.current.url;
        const state = stateFor(shared, url);
        if (state.steps >= shared.cfg.maxToolStepsPerPage) {
          return { error: `step budget for this page is exhausted; move to the next page`, moveOn: true };
        }
        const chosen = preset ?? "cta_click";
        shared.interactionSeq += 1;
        const stepId = `S-${chosen === "cta_click" ? "click" : chosen === "form_submit" ? "form" : "consent"}-${shared.interactionSeq}`;
        const out = await withAttempts(shared, url, `interact:${chosen}`, () =>
          fireInteraction(shared.current!.session.page, chosen, selector, stepId, shared.collector),
        );
        if ("error" in out) return out;
        state.steps += 1;
        const ids = recordCaptures(shared, out.fired, url, stepId);
        state.evidenceIds.push(...ids);
        shared.sse("interaction", { url, stepId, preset: chosen, detail: out.detail, firedEvents: ids.length });
        shared.store.log("interaction", { url, stepId, preset: chosen, detail: out.detail, evidence: ids.length });
        const fired = out.fired
          .flatMap((c) => (c.classified.kind === "beacon" ? c.classified.events : []))
          .slice(0, 12)
          .map((e) => ({ dest: e.dest, eventName: e.eventName }));
        return {
          ok: true,
          url,
          stepId,
          detail: out.detail,
          firedEvents: fired,
          evidenceIds: ids,
          stepsUsed: state.steps,
        };
      },
    }),

    record_evidence: tool({
      description:
        "Record an observation you made from tool results (a consent note, a duplicate event, an odd tag) into the append-only evidence store. Never use it to invent facts; only to note what tool results showed.",
      inputSchema: z.object({
        note: z.string().describe("One-sentence observation grounded in tool results"),
        url: z.string().optional().describe("Page URL the observation is about"),
      }),
      execute: async ({ note, url }) => {
        const guard = wallClockGuard(shared);
        if (guard) return guard;
        const pageUrl = url ?? shared.current?.url ?? shared.url;
        const e = shared.store.appendEvidence({
          pageUrl,
          timestamp: new Date().toISOString(),
          kind: "dom",
          source: "model",
          payload: { note },
        });
        shared.sse("evidence", { added: 1, modelNote: note.slice(0, 80) });
        return { ok: true, id: e?.id ?? null };
      },
    }),

    finish_crawl: tool({
      description: "End the crawl. Call this when every listed URL is done, or when a tool result says the budget is exhausted.",
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        await closeCurrent(shared);
        shared.finished = true;
        shared.finishReason = reason;
        shared.store.log("crawl_finished", { reason });
        const visited = [...shared.pageStates.entries()].filter(([, s]) => s.visited).map(([u]) => u);
        const failed = [...shared.pageStates.entries()].filter(([, s]) => s.failed).map(([u]) => u);
        return {
          ok: true,
          reason,
          pagesVisited: visited.length,
          pagesFailed: failed.length,
          evidenceCount: shared.store.listEvidence().length,
        };
      },
    }),
  };
}

/** Deterministic crawl-state summary for loop resumes (tool state outlives model context). */
function stateSummary(shared: CrawlShared, lastError: string): string {
  const visited = [...shared.pageStates.entries()].filter(([, s]) => s.visited).map(([u]) => u);
  const failed = [...shared.pageStates.entries()].filter(([, s]) => s.failed).map(([u]) => u);
  const remaining = shared.pages.filter((p) => !visited.includes(p) && !failed.includes(p));
  return [
    `Crawl state: ${visited.length} page(s) visited${failed.length > 0 ? `, ${failed.length} failed` : ""}, ${remaining.length} remaining.`,
    visited.length > 0 && visited.length <= 6 ? `Visited: ${visited.join(", ")}.` : "",
    failed.length > 0 ? `Failed (do not retry): ${failed.join(", ")}.` : "",
    remaining.length > 0 ? `Next unvisited URL: ${remaining[0]}.` : "",
    `Evidence so far: ${shared.store.listEvidence().length} entries.`,
    lastError ? `The previous call failed with: ${lastError}.` : "",
    "Continue the strict procedure; call finish_crawl when every listed URL is done.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Run the whole crawl with the Agents SDK tool-stepping loop. */
export async function runCrawl(shared: CrawlShared): Promise<CrawlSummary> {
  // NOTE: @openrouter/ai-sdk-provider v3 forbids system role messages — the
  // system prompt must go through the `system` (instructions) option.
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: `Audit the analytics instrumentation of ${shared.url}. Page budget: ${shared.pageBudget}. Follow the strict procedure.`,
    },
  ];
  let restarts = 0;
  const maxRestarts = 4;
  let lastError = "";

  while (!shared.finished && restarts < maxRestarts && Date.now() < shared.deadline) {
    restarts += 1;
    shared.store.log("loop_start", { restart: restarts });
    const loopStartIso = new Date().toISOString();
    try {
      const result = streamText({
        model: loopModel(shared.env as never, shared.crawlerModel),
        system: SYSTEM,
        messages,
        tools: buildTools(shared),
        stopWhen: stepCountIs(shared.cfg.maxToolStepsPerPage * Math.max(1, shared.pageBudget) + 12),
        providerOptions: LOW_EFFORT_PROVIDER_OPTIONS,
        onStepEnd: (step) => {
          try {
            const s = step as unknown as {
              stepNumber?: number;
              toolResults?: { toolName?: unknown }[];
              usage?: { inputTokens?: number; outputTokens?: number };
            };
            shared.store.log("loop_step", {
              step: s.stepNumber,
              tools: Array.isArray(s.toolResults) ? s.toolResults.map((r) => String((r as { toolName?: string }).toolName ?? "")) : [],
              usage: s.usage ? { input: s.usage.inputTokens, output: s.usage.outputTokens } : undefined,
            });
          } catch {
            /* accounting must never break the loop */
          }
        },
        onError: ({ error }) => {
          lastError = String(error).slice(0, 300);
          shared.store.log("loop_error", { error: lastError });
        },
      });
      await result.consumeStream();
      // Trace per best practices: ONE generation per model invocation (never
      // one aggregated per loop), tool calls as sibling `tool` observations,
      // thinking captured via reasoning_content.
      try {
        const steps = await result.steps;
        let elapsedMs = 0;
        const priorSteps: unknown[] = [];
        for (const step of steps) {
          const parts = (step.content ?? []) as Array<Record<string, unknown>>;
          const reasoning = parts.filter((p) => p.type === "reasoning").map((p) => String((p as { text?: string }).text ?? "")).filter(Boolean).join("\n");
          const text = parts.filter((p) => p.type === "text").map((p) => String((p as { text?: string }).text ?? "")).filter(Boolean).join("\n");
          const toolCalls = parts
            .filter((p) => p.type === "tool-call")
            .map((p) => ({ id: String(p.toolCallId ?? ""), name: String(p.toolName ?? ""), arguments: (p as { input?: unknown }).input }));
          const toolResults = parts.filter((p) => p.type === "tool-result");
          const stepUsage = (step as unknown as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
          const stepTime = (step as unknown as { performance?: { stepTimeMs?: number } }).performance?.stepTimeMs ?? 0;
          const stepStart = new Date(Date.parse(loopStartIso) + elapsedMs).toISOString();
          elapsedMs += stepTime;
          const stepEnd = stepTime > 0 ? new Date(Date.parse(loopStartIso) + elapsedMs).toISOString() : new Date().toISOString();
          const gen = shared.trace.startObservation({
            name: "decide-next-step",
            type: "generation",
            parent: shared.crawlObs,
            model: shared.crawlerModel,
            input: [...messages, ...priorSteps],
            metadata: { restart: restarts, stepNumber: step.stepNumber },
            startTime: stepStart,
          });
          gen.end({
            output: assistantMessage({ content: text, reasoning, toolCalls: toolCalls.filter((t) => t.id) }),
            usage: stepUsage ? { input: stepUsage.inputTokens, output: stepUsage.outputTokens, total: stepUsage.totalTokens } : undefined,
            endTime: stepEnd,
          });
          // Tool calls nest under the agent, as siblings of the generation.
          for (const call of toolCalls) {
            if (!call.id) continue;
            const toolObs = shared.trace.startObservation({
              name: call.name,
              type: "tool",
              parent: shared.crawlObs,
              input: call.arguments,
              metadata: { tool_call_id: call.id, restart: restarts, stepNumber: step.stepNumber },
            });
            const resultPart = toolResults.find((r) => String(r.toolCallId) === call.id);
            toolObs.end({ output: (resultPart as { output?: unknown } | undefined)?.output });
          }
          // Later model invocations saw these tool exchanges in context.
          if (toolCalls.length > 0) {
            priorSteps.push(
              assistantMessage({ content: text, reasoning, toolCalls: toolCalls.filter((t) => t.id) }),
              ...toolCalls.map((call) => {
                const resultPart = toolResults.find((r) => String(r.toolCallId) === call.id);
                return { role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify((resultPart as { output?: unknown } | undefined)?.output ?? null) };
              }),
            );
          } else if (text) {
            priorSteps.push({ role: "assistant", content: text });
          }
        }
      } catch {
        /* tracing must never break the loop */
      }
    } catch (e) {
      if (e instanceof ModelCallError && /not set|API key|API_KEY/i.test(e.message)) throw e;
      lastError = String(e).slice(0, 300);
      shared.store.log("loop_error", { error: lastError, restart: restarts });
    }
    if (shared.finished) break;
    if (restarts < maxRestarts) {
      messages.push({ role: "user", content: stateSummary(shared, lastError) });
    }
  }

  await closeCurrent(shared);
  const visited = [...shared.pageStates.entries()].filter(([, s]) => s.visited).map(([u]) => u);
  const failed = [...shared.pageStates.entries()].filter(([, s]) => s.failed).map(([u]) => u);
  if (!shared.finished) {
    shared.finishReason = `server-finalized: ${restarts >= maxRestarts ? "loop restart budget exhausted" : "wall-clock budget exhausted"}`;
    shared.store.log("crawl_finalized_server", { reason: shared.finishReason });
  }
  shared.sse("crawl_done", {
    finished: shared.finished,
    reason: shared.finishReason,
    pagesVisited: visited.length,
    pagesFailed: failed.length,
    evidenceCount: shared.store.listEvidence().length,
    restarts,
  });
  return {
    finished: shared.finished,
    finishReason: shared.finishReason,
    pagesVisited: visited,
    pagesFailed: failed,
    evidenceCount: shared.store.listEvidence().length,
    restarts,
  };
}
