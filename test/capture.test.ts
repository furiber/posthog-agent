import { describe, expect, it } from "vitest";
import {
  beaconEvidencePayload,
  classifyAnalyticsRequest,
  firstEventName,
  parseGa4Collect,
  parsePostHogEvents,
  parsePostHogInit,
  resolvePostHogEvents,
} from "../src/browser/capture";

/** Web-stdlib gzip (CompressionStream), available in Workers and Node 24. */
async function gzip(data: string): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("classifyAnalyticsRequest (on-the-wire detection)", () => {
  it("detects a PostHog ingestion beacon with a JSON event", () => {
    const body = JSON.stringify({ event: "cta_click", properties: { cta_text: "Get started" } });
    const out = classifyAnalyticsRequest("https://us.i.posthog.com/e/", "POST", body);
    expect(out?.kind).toBe("beacon");
    if (out?.kind === "beacon") {
      expect(out.dest).toBe("posthog");
      expect(out.events).toHaveLength(1);
      expect(out.events[0].eventName).toBe("cta_click");
      expect(out.events[0].props.cta_text).toBe("Get started");
    }
  });

  it("expands PostHog /batch payloads into one event each", () => {
    const body = JSON.stringify({ batch: [{ event: "page_view", properties: {} }, { event: "cta_click", properties: {} }] });
    const out = classifyAnalyticsRequest("https://us.i.posthog.com/batch", "POST", body);
    if (out?.kind === "beacon") {
      expect(out.dest).toBe("posthog");
      expect(out.events.map((e) => e.eventName)).toEqual(["page_view", "cta_click"]);
    } else {
      expect.unreachable("expected beacon");
    }
  });

  it("records the /decide config endpoint as evidence with zero events (no fabrication)", () => {
    const out = classifyAnalyticsRequest("https://us.i.posthog.com/decide?v=3", "POST", "{}");
    expect(out?.kind).toBe("beacon");
    if (out?.kind === "beacon") {
      expect(out.dest).toBe("posthog");
      expect(out.events).toHaveLength(0);
    }
    expect(firstEventName(out!)).toBeNull();
  });

  it("detects the GA4 Measurement Protocol collect endpoint with en= params", () => {
    const url =
      "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC1234567&en=cta_click&gtm=xyz&ep.cta_text=Start%20trial";
    const out = classifyAnalyticsRequest(url, "GET", null);
    expect(out?.kind).toBe("beacon");
    if (out?.kind === "beacon") {
      expect(out.dest).toBe("ga4");
      expect(out.events[0].eventName).toBe("cta_click");
      expect(out.events[0].props.tid).toBe("G-ABC1234567");
      expect(out.events[0].props.cta_text).toBe("Start trial");
    }
  });

  it("detects tag script loads (gtm.js container, gtag.js, posthog.js)", () => {
    const gtm = classifyAnalyticsRequest("https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234", "GET", null);
    expect(gtm?.kind).toBe("script");
    if (gtm?.kind === "script") {
      expect(gtm.dest).toBe("gtm");
      expect(gtm.tagId).toBe("GTM-ABC1234");
    }
    const gtag = classifyAnalyticsRequest("https://www.googletagmanager.com/gtag/js?id=G-ABC1234567", "GET", null);
    expect(gtag?.kind).toBe("script");
    if (gtag?.kind === "script") expect(gtag.dest).toBe("gtag");
    const ph = classifyAnalyticsRequest("https://us-assets.i.posthog.com/static/posthog.js", "GET", null);
    expect(ph?.kind).toBe("script");
    if (ph?.kind === "script") expect(ph.dest).toBe("posthog");
  });

  it("classifies legacy Universal Analytics collect as other", () => {
    const out = classifyAnalyticsRequest(
      "https://www.google-analytics.com/collect?v=1&tid=UA-123-1&ec=video&ea=play",
      "GET",
      null,
    );
    expect(out?.kind).toBe("beacon");
    if (out?.kind === "beacon") {
      expect(out.dest).toBe("other");
      expect(out.events[0].eventName).toBe("video_play");
    }
  });

  it("returns null for unrelated traffic (never fabricates)", () => {
    expect(classifyAnalyticsRequest("https://example.com/api/data", "POST", "{}")).toBeNull();
    expect(classifyAnalyticsRequest("https://cdn.example.com/app.js", "GET", null)).toBeNull();
  });
});

describe("PostHog behind a first-party proxy (F6, 2026-10-20)", () => {
  it("recognises the PostHog asset path on any host, and reports the proxy host", () => {
    for (const url of [
      "https://t.example.com/static/array.js",
      "https://t.example.com/static/1.380.0/array.js",
      "https://t.example.com/array/sTMFPsFhdP1Ssg/config.js",
    ]) {
      const out = classifyAnalyticsRequest(url, "GET", null);
      expect(out?.kind).toBe("script");
      if (out?.kind === "script") expect(out.dest).toBe("posthog");
    }
  });

  it("does not claim unrelated first-party scripts (ph.js alone is not enough)", () => {
    expect(classifyAnalyticsRequest("https://example.com/ph.js", "GET", null)).toBeNull();
    expect(classifyAnalyticsRequest("https://example.com/static/app.js", "GET", null)).toBeNull();
  });

  it("classifies ingestion beacons on a learned proxy host, with or without a body", () => {
    const opts = { posthogHosts: new Set(["t.example.com"]) };
    const body = JSON.stringify({ event: "$pageview", properties: { $current_url: "https://example.com/" } });
    const withBody = classifyAnalyticsRequest("https://t.example.com/e/?ip=1", "POST", body, opts);
    expect(withBody?.kind).toBe("beacon");
    if (withBody?.kind === "beacon") {
      expect(withBody.dest).toBe("posthog");
      expect(withBody.events[0].eventName).toBe("$pageview");
    }
    const gzipped = classifyAnalyticsRequest("https://t.example.com/i/v0/e/", "POST", null, opts);
    expect(gzipped?.kind === "beacon" && gzipped.dest === "posthog").toBe(true);
    const flags = classifyAnalyticsRequest("https://t.example.com/flags/?v=2", "POST", "{}", opts);
    expect(flags?.kind === "beacon" && flags.events.length === 0).toBe(true);
  });

  it("ignores the same paths on a host that was not learned", () => {
    expect(classifyAnalyticsRequest("https://t.example.com/e/", "POST", "{}")).toBeNull();
    expect(
      classifyAnalyticsRequest("https://other.example.com/e/", "POST", "{}", { posthogHosts: new Set(["t.example.com"]) }),
    ).toBeNull();
  });

  it("learns the api host and masked token from a script body containing posthog.init", () => {
    const text =
      '!function(){}();posthog.init("phc_tpSo7koHQsqe",{api_host:"https://t.nobodycame.app",ui_host:"https://eu.posthog.com",before_send:function(ev){return ev}});';
    expect(parsePostHogInit(text)).toEqual({ apiHost: "t.nobodycame.app", tokenMasked: "phc_tp…" });
    expect(parsePostHogInit("posthog.init('sTMFPsFhdP1Ssg', {api_host: 'https://us.i.posthog.com'})")).toEqual({
      apiHost: "us.i.posthog.com",
      tokenMasked: "sTMFPs…",
    });
    expect(parsePostHogInit("nothing to see here")).toBeNull();
  });
});

describe("parsePostHogEvents", () => {
  it("survives undecodable (compressed) bodies without inventing events", () => {
    expect(parsePostHogEvents("")).toHaveLength(0);
    expect(parsePostHogEvents("binary")).toHaveLength(0);
    expect(parsePostHogEvents(JSON.stringify({ token: "phc_x", batch: "nope" }))).toHaveLength(0);
  });

  it("parses urlencoded form bodies", () => {
    const body = `data=${encodeURIComponent(JSON.stringify({ event: "form_submit", properties: { form_id: 1 } }))}`;
    const events = parsePostHogEvents(body);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("form_submit");
  });
});

describe("resolvePostHogEvents (real posthog-js body forms)", () => {
  it("gunzips raw gzipped bodies (Content-Encoding: gzip, the 1.4x default)", async () => {
    const gzipped = await gzip(JSON.stringify({ event: "cta_click", properties: { cta_text: "Start" } }));
    const { events, text } = await resolvePostHogEvents(gzipped);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("cta_click");
    expect(events[0].props.cta_text).toBe("Start");
    expect(text).toContain("cta_click");
  });

  it("unpacks gzip-base64 envelopes", async () => {
    const base64 = btoa(String.fromCharCode(...(await gzip(JSON.stringify({ batch: [{ event: "page_view", properties: {} }] })))));
    const body = JSON.stringify({ compression: "gzip-base64", data: base64 });
    const { events } = await resolvePostHogEvents(body);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("page_view");
  });

  it("returns no events for garbage (never fabricates)", async () => {
    const { events } = await resolvePostHogEvents("not-json-at-all");
    expect(events).toHaveLength(0);
    const none = await resolvePostHogEvents(null);
    expect(none.events).toHaveLength(0);
  });
});

describe("parseGa4Collect", () => {
  it("requires en= and maps ep.*/epn.* params", () => {
    const empty = parseGa4Collect(new URLSearchParams("v=2&tid=G-1"));
    expect(empty).toHaveLength(0);
    const params = new URLSearchParams("v=2&tid=G-1&en=page_view&ep.page_location=https%3A%2F%2Fexample.com%2F");
    const events = parseGa4Collect(params);
    expect(events[0].eventName).toBe("page_view");
    expect(events[0].props.page_location).toBe("https://example.com/");
  });
});

describe("beaconEvidencePayload", () => {
  it("keeps the request URL redacted (no query strings) and events parsed", () => {
    const capture = {
      captureId: "C1",
      pageUrl: "https://example.com/",
      timestamp: "2026-10-19T00:00:00.000Z",
      requestUrl: "https://us.i.posthog.com/e/?ip=1",
      method: "POST",
      classified: {
        kind: "beacon" as const,
        dest: "posthog" as const,
        events: [{ dest: "posthog" as const, eventName: "cta_click", props: { cta_text: "Hi" } }],
      },
    };
    const payload = beaconEvidencePayload(capture);
    expect(payload.requestUrl).toBe("https://us.i.posthog.com/e/");
    expect(payload.events).toHaveLength(1);
    expect(payload.method).toBe("POST");
  });
});
