import { describe, expect, it } from "vitest";
import { otelAttributes, otelTraceId, otlpBody, Trace } from "../src/trace";

describe("otelTraceId", () => {
  it("maps a UUID to its 32-hex form", () => {
    expect(otelTraceId("0186e7f1-fe0a-4394-90e1-ecf7f4021234")).toBe("0186e7f1fe0a439490e1ecf7f4021234");
  });
  it("hashes non-UUID ids deterministically to 32 hex chars", () => {
    const a = otelTraceId("some-custom-run-id");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(otelTraceId("some-custom-run-id"));
  });
});

function spansOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const rs = (body.resourceSpans as Array<{ scopeSpans: Array<{ spans: Record<string, unknown>[] }> }>)[0]!;
  return rs.scopeSpans[0]!.spans;
}

describe("otlpBody (Langfuse v4 OTLP/HTTP JSON)", () => {
  it("builds resource spans with hex ids, nanos timestamps, types, and attribute filtering", () => {
    const body = otlpBody({
      traceId: "a".repeat(32),
      serviceName: "analytics-audit-agent",
      scopeName: "analytics-audit-trace",
      shared: { "langfuse.trace.name": "analytics-audit", "langfuse.session.id": "coffeerouletteapp.com" },
      spans: [
        {
          spanId: "b".repeat(16),
          name: "crawl-site",
          type: "agent",
          start: "2026-10-19T00:00:00.000Z",
          end: "2026-10-19T00:01:00.000Z",
          attributes: {} as never,
        } as never,
        {
          spanId: "c".repeat(16),
          parentSpanId: "b".repeat(16),
          name: "decide-next-step",
          type: "generation",
          model: "z-ai/glm-5.3-flash",
          start: "2026-10-19T00:00:01.000Z",
          end: "2026-10-19T00:00:02.000Z",
          usage: { input: 1533, output: 290, total: 1823, cost: 0.0002 },
          attributes: {
            "langfuse.observation.output": undefined, // filtered out
          } as never,
        } as never,
      ],
    });
    const resource = (body.resourceSpans as Array<{ resource: { attributes: { key: string }[] } }>)[0]!;
    expect(resource.resource.attributes[0]!.key).toBe("service.name");
    const [agent, gen] = spansOf(body) as [Record<string, unknown>, Record<string, unknown>];
    expect(agent.traceId).toBe("a".repeat(32));
    expect(agent.startTimeUnixNano).toBe(String(BigInt(Date.parse("2026-10-19T00:00:00.000Z")) * 1_000_000n));
    expect(gen.parentSpanId).toBe("b".repeat(16));
    const attrs = (gen.attributes as { key: string; value: { stringValue: string } }[]);
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
    expect(byKey["langfuse.observation.type"]).toBe("generation");
    expect(byKey["langfuse.observation.model.name"]).toBe("z-ai/glm-5.3-flash");
    expect(JSON.parse(byKey["langfuse.observation.usage_details"]!)).toEqual({ input: 1533, output: 290, total: 1823 });
    expect(JSON.parse(byKey["langfuse.observation.cost_details"]!)).toEqual({ total: 0.0002 });
    expect("langfuse.observation.output" in byKey).toBe(false);
  });
});

describe("Trace (hierarchical observations)", () => {
  it("nests generations under agent observations with session and environment", () => {
    const t = new Trace("0186e7f1-fe0a-4394-90e1-ecf7f4021234", "analytics-audit", { url: "https://x.com", pageBudget: 3 }, { sessionId: "x.com", environment: "development", tags: ["analytics-audit"] });
    const crawl = t.startObservation({ name: "crawl-site", type: "agent", input: { url: "https://x.com" } });
    const gen = crawl.startChild({ name: "decide-next-step", type: "generation", model: "z-ai/glm-5.3-flash", input: [{ role: "user", content: "go" }] });
    gen.end({ output: { role: "assistant", content: "ok", reasoning_content: "thinking..." }, usage: { input: 10, output: 5, total: 15 } });
    const tool = crawl.startChild({ name: "load_page", type: "tool", input: { url: "https://x.com" }, metadata: { tool_call_id: "call_1" } });
    tool.end({ output: { ok: true } });
    crawl.end({ output: { pagesVisited: 1 } });
    t.end({ sections: { events: 6 } }, { evidenceCount: 92 });
  });

  it("otelAttributes drops undefined values (Langfuse rejects empty attribute values)", () => {
    const attrs = otelAttributes({ a: "x", b: undefined });
    expect(attrs).toHaveLength(1);
    expect(attrs[0]!.key).toBe("a");
  });
});
