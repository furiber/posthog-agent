import { Agent } from "agents";
import { ensureSchema, handleGetReport, handleRun, type RunAgent } from "./run";

/**
 * Analytics Audit Agent — one Agents SDK Agent instance per run (the DO
 * instance name is the run id). All four roles (crawler, synthesizer,
 * adversarial reviewer, Jev adjudicator) share this one agent state: evidence
 * IDs survive every handoff. The adversarial reviewer's fresh context is the
 * sole exception — it is a fresh model call, never a separate agent session.
 */

export interface AnalyticsAgentState {
  runs: number;
}

export class AnalyticsAuditAgent extends Agent<Env, AnalyticsAgentState> {
  initialState: AnalyticsAgentState = { runs: 0 };

  /** Detached pipeline work is referenced so it is never dropped mid-run. */
  readonly activeWork = new Set<Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureSchema(this.asRunAgent());
  }

  /** HTTP requests not claimed by the Agents SDK lifecycle land here. */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && (url.pathname.endsWith("/run") || url.pathname === "/")) {
      return handleRun(this.asRunAgent(), request, (pipeline) => {
        this.activeWork.add(pipeline);
        void pipeline.finally(() => this.activeWork.delete(pipeline));
      });
    }
    if (request.method === "GET" && url.pathname.endsWith("/report.md")) {
      return handleGetReport(this.asRunAgent(), "md");
    }
    if (request.method === "GET" && url.pathname.endsWith("/report")) {
      return handleGetReport(this.asRunAgent(), "json");
    }
    return new Response("Not found", { status: 404 });
  }

  private asRunAgent(): RunAgent {
    return { ctx: this.ctx, env: this.env };
  }
}
