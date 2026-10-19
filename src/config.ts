import { z } from "zod";

/** Run budgets. Defaults mirror cloudflare.config.ts AGENT_CONFIG; the JSON
 * binding value overrides them, and both are validated leniently here. */
export const AgentConfigSchema = z.object({
  /** Default page budget when the run request omits it. */
  pageBudgetDefault: z.number().int().min(1).max(200).default(50),
  /** Hard cap on any run's page budget. */
  pageBudgetMax: z.number().int().min(1).max(200).default(200),
  /** Max successful tool steps per page. */
  maxToolStepsPerPage: z.number().int().min(1).default(40),
  /** Retries for a failing tool step. */
  toolAttemptLimit: z.number().int().min(1).default(4),
  /** Pages that fail to render or are marked complex (SPA, heavy client routing) get this instead. */
  complexToolAttemptLimit: z.number().int().min(1).default(8),
  /** Per-run wall-clock cap. */
  wallClockCapMs: z.number().int().min(10_000).default(600_000),
  /** draft -> critique -> Jev -> revise loop bound. */
  maxValidationRounds: z.number().int().min(1).default(3),
  /** Concurrent browser contexts the crawler may use (tool-level concurrency). */
  crawlParallelism: z.number().int().min(1).max(4).default(2),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const DEFAULT_AGENT_CONFIG: AgentConfig = AgentConfigSchema.parse({});

export function loadAgentConfig(raw: unknown): AgentConfig {
  const parsed = AgentConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_AGENT_CONFIG;
}

/** Model ids and endpoint URLs from the Worker env (bindings). */
export interface ModelEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  CRAWLER_MODEL?: string;
  SYNTHESIZER_MODEL?: string;
  REVIEWER_MODEL?: string;
  JEV_API_URL?: string;
  JEV_MODEL?: string;
}

export const MODEL_DEFAULTS = {
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
  crawler: "deepseek/deepseek-v4.1-flash",
  synthesizer: "deepseek/deepseek-v4.1-flash",
  reviewer: "z-ai/glm-5.3-flash",
  jevApiUrl: "https://api.typesafe.ai/v1/systemone",
  jevModel: "jev-latest",
} as const;

export function resolveModels(env: ModelEnv) {
  return {
    baseUrl: env.OPENROUTER_BASE_URL || MODEL_DEFAULTS.openRouterBaseUrl,
    apiKey: env.OPENROUTER_API_KEY,
    crawler: env.CRAWLER_MODEL || MODEL_DEFAULTS.crawler,
    synthesizer: env.SYNTHESIZER_MODEL || MODEL_DEFAULTS.synthesizer,
    reviewer: env.REVIEWER_MODEL || MODEL_DEFAULTS.reviewer,
    jevApiUrl: env.JEV_API_URL || MODEL_DEFAULTS.jevApiUrl,
    jevModel: env.JEV_MODEL || MODEL_DEFAULTS.jevModel,
  };
}
export type ResolvedModels = ReturnType<typeof resolveModels>;
