import { getAgentByName, routeAgentRequest } from "agents";
import { statusPageHtml } from "./statusPage";
import { RunRequestSchema } from "./schemas/run";
import { AnalyticsAuditAgent } from "./agent";

export { AnalyticsAuditAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Placeholder status/entry page (SSE consumer).
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(statusPageHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "analytics-audit-agent" });
    }

    // Start a run; the Durable Object streams progress as SSE.
    if (request.method === "POST" && url.pathname === "/run") {
      const body: unknown = await request.json().catch(() => null);
      const parsed = RunRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          {
            error: "invalid body; expected { url: public http(s) URL, pageBudget?: 1..200 }",
            issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
          },
          { status: 400 },
        );
      }
      const runId = crypto.randomUUID();
      // The string-referenced same-worker DO binding infers as DurableObjectNamespace<undefined>;
      // point it at the exported agent class explicitly.
      const agent = await getAgentByName<Env, AnalyticsAuditAgent>(
        env.ANALYTICS_AUDIT_AGENT as DurableObjectNamespace<AnalyticsAuditAgent>,
        runId,
      );
      const forwarded = new Request(new URL("/run", url.origin).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-run-id": runId },
        body: JSON.stringify(parsed.data),
      });
      return agent.fetch(forwarded);
    }

    // Fetch a finished run's report (json or markdown).
    if (request.method === "GET" && url.pathname.startsWith("/runs/")) {
      const parts = url.pathname.split("/").filter(Boolean); // runs, :id, report(.md)
      const runId = parts[1];
      if (!runId || !/^[a-f0-9-]{8,64}$/i.test(runId)) {
        return new Response("bad run id", { status: 400 });
      }
      const suffix = parts[2] === "report.md" ? "/report.md" : "/report";
      const agent = await getAgentByName<Env, AnalyticsAuditAgent>(
        env.ANALYTICS_AUDIT_AGENT as DurableObjectNamespace<AnalyticsAuditAgent>,
        runId,
      );
      return agent.fetch(new Request(new URL(`/runs/${runId}${suffix}`, url.origin).toString(), { method: "GET", headers: { "x-run-id": runId } }));
    }

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
