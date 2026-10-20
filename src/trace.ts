/**
 * Langfuse v4 tracing — zero SDK, OTLP/HTTP JSON ingest
 * (`POST {LANGFUSE_BASE_URL}/api/public/otel/v1/traces` with
 * `x-langfuse-ingestion-version: 4`), Workers-native.
 *
 * Structure follows https://langfuse.com/docs/observability/best-practices:
 * - one trace per run (the self-contained unit of work); sessionId groups
 *   runs against the same site;
 * - role phases as `agent` observations; every model invocation as its own
 *   `generation` (never one aggregated generation per loop) with thinking
 *   captured via `reasoning_content`; every tool call as a `tool`
 *   observation nested under the agent that orchestrated it, as a sibling of
 *   the generation that requested it;
 * - verb-first, dynamic-free names (crawl-site, decide-next-step,
 *   synthesize-report, critique-draft, grade-critique); run-specific values
 *   live in metadata;
 * - model name + usage_details + cost_details on every generation;
 * - root input = what a reviewer needs at a glance ({url, pageBudget});
 *   raw payloads (report markdown) go in metadata.
 *
 * Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; a tracing
 * failure never fails a run.
 */

export type ObservationType = "agent" | "generation" | "tool" | "span";

export interface UsageDetails {
  input?: number;
  output?: number;
  total?: number;
  cost?: number;
}

export interface LangfuseEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_ENVIRONMENT?: string;
}

export const langfuseEnabled = (env: LangfuseEnv): boolean =>
  !!env.LANGFUSE_PUBLIC_KEY && !!env.LANGFUSE_SECRET_KEY;

export function langfuseBaseUrl(env: LangfuseEnv): string {
  // Default to the US cloud (as the config comment and README state); the EU default returned 401 for US keys (F24, 2026-10-21).
  return (env.LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com").replace(/\/$/, "");
}

/** OTEL trace id (32 hex chars) for a run id; a UUID maps to itself without dashes. */
export function otelTraceId(id: string): string {
  const hex = id.toLowerCase().replace(/-/g, "");
  if (/^[0-9a-f]{32}$/.test(hex)) return hex;
  const bytes = [...new TextEncoder().encode(id)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return bytes.padEnd(32, "0").slice(0, 32);
}

const spanId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const nanos = (iso: string): string => `${BigInt(Date.parse(iso)) * 1_000_000n}`;
const json = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v ?? null));

export function otelAttributes(o: Record<string, string | undefined>): { key: string; value: { stringValue: string } }[] {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({ key, value: { stringValue: v! } }));
}

interface SpanRecord {
  spanId: string;
  parentSpanId?: string;
  name: string;
  type: ObservationType;
  model?: string;
  start: string;
  end?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  usage?: UsageDetails;
  error?: string;
}

/** Builds the OTLP/HTTP JSON request body for the pending spans (pure; unit-tested). */
export function otlpBody(args: {
  traceId: string;
  serviceName: string;
  scopeName: string;
  shared: Record<string, string | undefined>;
  spans: SpanRecord[];
}): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: otelAttributes({ "service.name": args.serviceName }) },
        scopeSpans: [
          {
            scope: { name: args.scopeName },
            spans: args.spans.map((s) => {
              const attrs: Record<string, string | undefined> = {
                ...args.shared,
                "langfuse.observation.type": s.type,
                "langfuse.observation.model.name": s.model,
                "langfuse.observation.input": s.input === undefined ? undefined : json(s.input),
                "langfuse.observation.output": s.output === undefined ? undefined : json(s.output),
                // Per-key metadata prefix maps to filterable top-level metadata keys.
                ...(s.metadata &&
                  Object.fromEntries(
                    Object.entries(s.metadata).map(([k, v]) => [`langfuse.observation.metadata.${k}`, json(v)]),
                  )),
                ...(s.usage && {
                  "langfuse.observation.usage_details": JSON.stringify({
                    input: s.usage.input ?? 0,
                    output: s.usage.output ?? 0,
                    total: s.usage.total ?? (s.usage.input ?? 0) + (s.usage.output ?? 0),
                  }),
                  ...(s.usage.cost !== undefined && {
                    "langfuse.observation.cost_details": JSON.stringify({ total: s.usage.cost }),
                  }),
                }),
                ...(s.error && {
                  "langfuse.observation.level": "ERROR",
                  "langfuse.observation.status_message": s.error,
                }),
              };
              return {
                traceId: args.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId && { parentSpanId: s.parentSpanId }),
                name: s.name,
                kind: 1,
                startTimeUnixNano: nanos(s.start),
                endTimeUnixNano: nanos(s.end ?? s.start),
                attributes: otelAttributes(attrs),
                status: { code: s.error ? 2 : 1 },
              };
            }),
          },
        ],
      },
    ],
  };
}

/** An in-flight observation; end() completes it. */
export class Observation {
  constructor(
    private readonly trace: Trace,
    readonly spanId: string,
    private readonly record: SpanRecord,
  ) {}

  end(args?: { output?: unknown; usage?: UsageDetails; error?: string; endTime?: string }): void {
    this.record.end = args?.endTime ?? new Date().toISOString();
    if (args?.output !== undefined) this.record.output = args.output;
    if (args?.usage) this.record.usage = args.usage;
    if (args?.error) this.record.error = args.error;
  }

  /** Start a child observation nested under this one. */
  startChild(s: {
    name: string;
    type: ObservationType;
    model?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    startTime?: string;
  }): Observation {
    return this.trace.startObservation({ ...s, parent: this });
  }
}

export class Trace {
  readonly traceId: string;
  private readonly startTime = new Date().toISOString();
  private readonly spans: SpanRecord[] = [];
  private readonly rootSpanId = spanId();
  private output: unknown;
  private traceMetadata?: Record<string, unknown>;
  private rootSent = false;
  /** What Langfuse answered to the last send. Unset until a send happens. */
  ingest?: { ok: boolean; status?: number; detail?: string };

  constructor(
    readonly id: string,
    private readonly name: string,
    private readonly input: unknown,
    private readonly opts?: { sessionId?: string; environment?: string; tags?: string[] },
  ) {
    this.traceId = otelTraceId(id);
    // The root observation carries the trace-level input/output.
    this.spans.push({
      spanId: this.rootSpanId,
      name: this.name,
      type: "span",
      start: this.startTime,
      input: this.input,
    });
  }

  startObservation(s: {
    name: string;
    type: ObservationType;
    parent?: Observation;
    model?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    startTime?: string;
  }): Observation {
    const record: SpanRecord = {
      spanId: spanId(),
      ...(s.parent && { parentSpanId: s.parent.spanId }),
      name: s.name,
      type: s.type,
      ...(s.model && { model: s.model }),
      ...(s.input !== undefined && { input: s.input }),
      ...(s.metadata && { metadata: s.metadata }),
      start: s.startTime ?? new Date().toISOString(),
    };
    this.spans.push(record);
    return new Observation(this, record.spanId, record);
  }

  /** Sets the root observation's output and trace-level metadata. */
  end(output: unknown, metadata?: Record<string, unknown>): void {
    this.output = output;
    this.traceMetadata = metadata;
  }

  /** Sends every span not yet sent. No-op without keys; never throws. */
  async flush(env: LangfuseEnv): Promise<void> {
    if (!langfuseEnabled(env)) return;
    const root = this.spans.find((s) => s.spanId === this.rootSpanId);
    if (root && this.output !== undefined) root.output = this.output;
    const now = new Date().toISOString();
    for (const s of this.spans) {
      if (!s.end) s.end = now; // close anything left open so the tree renders
    }
    // Langfuse v4 filters/aggregates per observation, so trace-wide context
    // (name, session, environment, tags, metadata) goes on every span.
    const shared: Record<string, string | undefined> = {
      "langfuse.trace.name": this.name,
      ...(this.opts?.sessionId && { "langfuse.session.id": this.opts.sessionId }),
      "langfuse.environment": this.opts?.environment || env.LANGFUSE_ENVIRONMENT || "production",
      ...(this.opts?.tags && { "langfuse.trace.tags": JSON.stringify(this.opts.tags) }),
      ...Object.fromEntries(
        Object.entries(this.traceMetadata ?? {}).map(([k, v]) => [`langfuse.trace.metadata.${k}`, json(v)]),
      ),
    };
    const body = otlpBody({
      traceId: this.traceId,
      serviceName: "analytics-audit-agent",
      scopeName: "analytics-audit-trace",
      shared,
      spans: this.spans.slice(),
    });
    const auth = btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`);
    try {
      const res = await fetch(`${langfuseBaseUrl(env)}/api/public/otel/v1/traces`, {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
          "x-langfuse-ingestion-version": "4",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        this.ingest = { ok: true, status: res.status };
      } else {
        const detail = (await res.text()).slice(0, 300);
        this.ingest = { ok: false, status: res.status, detail };
        console.error("Langfuse ingestion failed", res.status, detail);
      }
    } catch (e) {
      this.ingest = { ok: false, detail: String(e).slice(0, 300) };
      console.error("Langfuse ingestion failed", String(e).slice(0, 300));
    }
  }
}

/** Build an OpenAI-format assistant message for a generation's output —
 * role-labeled, with thinking (reasoning_content) and tool_calls rendered. */
export function assistantMessage(args: {
  content?: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
}): Record<string, unknown> {
  return {
    role: "assistant",
    ...(args.content ? { content: args.content } : {}),
    ...(args.reasoning ? { reasoning_content: args.reasoning } : {}),
    ...(args.toolCalls && args.toolCalls.length > 0
      ? {
          tool_calls: args.toolCalls.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.arguments) },
          })),
        }
      : {}),
  };
}
