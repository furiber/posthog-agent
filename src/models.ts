import { createOpenRouter, type OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import type { z } from "zod";
import { resolveModels, type ModelEnv, type ResolvedModels } from "./config";

/**
 * Model access: an OpenAI-compatible endpoint, OpenRouter by default.
 * Point OPENROUTER_BASE_URL at a Cloudflare AI Gateway OpenAI-compatible
 * URL to route the same code through AI Gateway instead.
 *
 * The models are deliberately weak, cheap, flash-tier (GLM 5.3 Flash and
 * DeepSeek 4.1 flash class). Every prompt is designed for them: one job per
 * call, small structured JSON outputs. GLM 5.3 defaults to max reasoning
 * effort on OpenRouter, which is slow — all calls pin effort low.
 */

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface ChatJsonArgs {
  system: string;
  user: string;
  model: string;
  maxTokens?: number;
  /** Extra retries with the validation error appended (weak-model tolerance). */
  validate?: (text: string) => { ok: true; value: unknown } | { ok: false; error: string };
  onAttempt?: (info: { attempt: number; error?: string; ms: number }) => void;
}

const TIMEOUT_MS = 90_000;

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export class ModelCallError extends Error {}

/** One JSON-mode chat call through the OpenAI-compatible endpoint. */
export async function chatJson(env: ModelEnv, args: ChatJsonArgs): Promise<{ text: string; usage?: ChatUsage }> {
  const models = resolveModels(env);
  if (!models.apiKey) {
    throw new ModelCallError("OPENROUTER_API_KEY is not set (fill .env for local dev, or upload with cf deploy --secrets-file .env)");
  }
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: args.system },
    { role: "user", content: args.user },
  ];
  let lastError = "";
  let maxTokens = args.maxTokens ?? 2000;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(endpoint(models.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${models.apiKey}`,
          "content-type": "application/json",
          "x-title": "analytics-audit-agent",
        },
        body: JSON.stringify({
          model: args.model,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          usage: { include: true },
          // GLM 5.3 would otherwise default to max reasoning effort.
          reasoning: { effort: "low" },
          messages,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      lastError = `transport: ${String(e).slice(0, 200)}`;
      args.onAttempt?.({ attempt, error: lastError, ms: Date.now() - started });
      await backoff(attempt);
      continue;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      args.onAttempt?.({ attempt, error: lastError, ms: Date.now() - started });
      // Retry rate limits and server errors; do not retry 4xx auth/schema errors.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await backoff(attempt);
        continue;
      }
      throw new ModelCallError(`OpenRouter ${lastError}`);
    }
    const body = (await res.json().catch(() => null)) as
      | {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: ChatUsage;
        }
      | null;
    const choice = body?.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (!text.trim()) {
      // Reasoning models burn max_tokens before emitting content; retry with a bigger budget.
      const detail = `empty completion (finish_reason=${choice?.finish_reason ?? "unknown"}, usage=${JSON.stringify(body?.usage ?? {})})`;
      lastError = detail;
      args.onAttempt?.({ attempt, error: detail, ms: Date.now() - started });
      maxTokens = Math.min(maxTokens * 2, 16000);
      messages.length = 2; // drop any repair tail before retrying
      await backoff(attempt);
      continue;
    }
    if (args.validate) {
      const v = args.validate(text);
      if (!v.ok) {
        lastError = `validation: ${v.error.slice(0, 200)}`;
        args.onAttempt?.({ attempt, error: lastError, ms: Date.now() - started });
        messages.push(
          { role: "assistant", content: text.slice(0, 4000) },
          {
            role: "user",
            content: `Your reply failed this check: ${v.error}. Reply again with ONLY a corrected JSON object that passes it.`,
          },
        );
        await backoff(attempt);
        continue;
      }
    }
    args.onAttempt?.({ attempt, ms: Date.now() - started });
    return { text, usage: body?.usage };
  }
  throw new ModelCallError(`chat failed after ${maxAttempts} attempts: ${lastError}`);
}

/** chatJson + JSON object extraction + Zod validation (with one repair retry). */
export async function chatJsonParsed<T>(
  env: ModelEnv,
  args: Omit<ChatJsonArgs, "validate">,
  schema: z.ZodType<T>,
): Promise<{ value: T; usage?: ChatUsage }> {
  const { text, usage } = await chatJson(env, {
    ...args,
    validate: (t) => {
      const parsed = extractJson(t);
      if (parsed === null) return { ok: false, error: "reply is not a single JSON object" };
      const res = schema.safeParse(parsed);
      return res.success
        ? { ok: true, value: res.data }
        : { ok: false, error: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 300) };
    },
  });
  const value = schema.parse(extractJson(text));
  return { value, usage };
}

/** Outermost JSON object in a reply, tolerating code fences and stray text. */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)));
}

/** LanguageModel for the Agents SDK tool-stepping loop (streamText + tools). */
export function loopModel(env: ModelEnv, modelId: string): ReturnType<OpenRouterProvider> {
  const models = resolveModels(env);
  if (!models.apiKey) {
    throw new ModelCallError("OPENROUTER_API_KEY is not set (fill .env for local dev, or upload with cf deploy --secrets-file .env)");
  }
  const openrouter = createOpenRouter({ apiKey: models.apiKey, baseURL: models.baseUrl });
  return openrouter.chat(modelId);
}

/** providerOptions pinning GLM 5.3's reasoning effort to low in the tool loop. */
export const LOW_EFFORT_PROVIDER_OPTIONS = {
  openrouter: { reasoning: { effort: "low" as const } },
} as const;

export type { ResolvedModels };
