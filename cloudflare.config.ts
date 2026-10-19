import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { readFileSync } from "node:fs";

/**
 * Optional-secret support: Langfuse tracing only ships when both keys are
 * present in `.env` (read at config-eval time); otherwise the bindings are
 * omitted entirely so deploys succeed with tracing off.
 */
function envFileValue(name: string): string | undefined {
  try {
    const line = readFileSync(new URL("./.env", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    const value = line?.slice(line.indexOf("=") + 1).trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

const langfuseKeys =
  envFileValue("LANGFUSE_PUBLIC_KEY") && envFileValue("LANGFUSE_SECRET_KEY");

/**
 * Analytics Audit Agent — cf CLI project config.
 *
 * Budgets and caps (pageBudget, tool steps, wall clock) live in the AGENT_CONFIG
 * JSON binding below, so a run's behavior is a pure function of this file.
 * Local dev (`cf dev`) reads secrets from `.env` / `.dev.vars`.
 */
export default defineConfig({
  worker: {
    name: "analytics-audit-agent",
    entrypoint,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    observability: {
      enabled: true,
      logs: { enabled: true },
    },
    env: {
      // Durable Object agent (the Agents SDK Agent class lives here).
      ANALYTICS_AUDIT_AGENT: bindings.durableObject({
        worker: "analytics-audit-agent",
        exportName: "AnalyticsAuditAgent",
      }),
      // Cloudflare Browser Rendering binding. In production it drives the
      // remote headless Chromium; in `cf dev` the @cloudflare/playwright
      // fork launches a local Chrome against the same tool interface.
      BROWSER: bindings.browser(),
      // Model access: OpenAI-compatible endpoint (OpenRouter by default;
      // point OPENROUTER_BASE_URL at an AI Gateway URL to route through it).
      OPENROUTER_API_KEY: bindings.secret(),
      OPENROUTER_BASE_URL: bindings.text("https://openrouter.ai/api/v1"),
      CRAWLER_MODEL: bindings.text("deepseek/deepseek-v4.1-flash"),
      SYNTHESIZER_MODEL: bindings.text("deepseek/deepseek-v4.1-flash"),
      REVIEWER_MODEL: bindings.text("z-ai/glm-5.3-flash"),
      // Jev grader (TypeSafe systemone API, choice grader).
      TYPESAFE_API_KEY: bindings.secret(),
      JEV_API_URL: bindings.text("https://api.typesafe.ai/v1/systemone"),
      JEV_MODEL: bindings.text("jev-latest"),
      // Langfuse v4 tracing (OTLP ingest; tracing only ships when the keys are set).
      LANGFUSE_BASE_URL: bindings.text("https://us.cloud.langfuse.com"),
      LANGFUSE_PUBLIC_KEY: langfuseKeys ? bindings.secret() : undefined,
      LANGFUSE_SECRET_KEY: langfuseKeys ? bindings.secret() : undefined,
      // Run budgets: page budget, per-page tool steps, retries, wall clock.
      AGENT_CONFIG: bindings.json({
        pageBudgetDefault: 50,
        pageBudgetMax: 200,
        maxToolStepsPerPage: 40,
        toolAttemptLimit: 4,
        complexToolAttemptLimit: 8,
        wallClockCapMs: 600_000,
        maxValidationRounds: 3,
        crawlParallelism: 2,
      }),
    },
    exports: {
      AnalyticsAuditAgent: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
