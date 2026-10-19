import {
  buildJevCritiqueRequest,
  parseJevGrading,
  type JevGrading,
} from "./schemas/jev";
import type { Observation } from "./trace";

/**
 * Jev adjudicator: a separate grader model call to the TypeSafe systemone
 * API. Any transport works; this build POSTs the choice grader directly.
 * Only critiques graded Correct propagate. Failures are retried; if Jev is
 * unreachable the run degrades honestly (critiques left ungraded, reported
 * in the appendix) rather than falling back to a chat model.
 */

export interface Jenv {
  TYPESAFE_API_KEY?: string;
  JEV_API_URL?: string;
  JEV_MODEL?: string;
}

export class JevUnavailableError extends Error {}

export async function jevGradeCritique(
  env: Jenv,
  args: {
    critiqueId: string;
    critique: string;
    draftStatement: string;
    citedEvidence: unknown[];
    model: string;
    apiUrl: string;
  },
  onAttempt?: (info: { attempt: number; error?: string; ms: number }) => void,
  roundObs?: Observation,
): Promise<JevGrading> {
  const key = env.TYPESAFE_API_KEY;
  if (!key) throw new JevUnavailableError("TYPESAFE_API_KEY is not set");
  const body = buildJevCritiqueRequest({
    model: args.model,
    critique: args.critique,
    draftStatement: args.draftStatement,
    citedEvidence: args.citedEvidence,
  });
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    const startIso = new Date().toISOString();
    try {
      const res = await fetch(args.apiUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
        onAttempt?.({ attempt, error: lastError, ms: Date.now() - started });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        roundObs?.startChild({
          name: "grade-critique",
          type: "generation",
          model: args.model,
          input: body,
          metadata: { critiqueId: args.critiqueId, attempt },
          startTime: startIso,
        }).end({ error: lastError });
        throw new JevUnavailableError(`Jev ${lastError}`);
      }
      const json: unknown = await res.json();
      const grading = parseJevGrading(json, args.critiqueId);
      if (!grading) {
        lastError = "malformed answer (no verdict choice)";
        onAttempt?.({ attempt, error: lastError, ms: Date.now() - started });
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      onAttempt?.({ attempt, ms: Date.now() - started });
      // Jev bills input tokens only ($0.042 / 1M, output free).
      const usage = (json as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      roundObs?.startChild({
        name: "grade-critique",
        type: "generation",
        model: args.model,
        input: body,
        metadata: { critiqueId: args.critiqueId, attempt },
        startTime: startIso,
      }).end({
        output: grading,
        usage: usage
          ? {
              input: usage.input_tokens,
              output: usage.output_tokens,
              total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
              cost: ((usage.input_tokens ?? 0) * 0.042) / 1_000_000,
            }
          : undefined,
      });
      return grading;
    } catch (e) {
      if (e instanceof JevUnavailableError) throw e;
      lastError = String(e).slice(0, 200);
      onAttempt?.({ attempt, error: lastError, ms: Date.now() - started });
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new JevUnavailableError(`Jev unreachable: ${lastError}`);
}
