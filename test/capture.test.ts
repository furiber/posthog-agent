import { describe, expect, it } from "vitest";
import {
  analyticsLike,
  beaconEvidencePayload,
  classifyAnalyticsRequest,
  isKnownNoise,
  firstEventName,
  parseCspViolation,
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

describe("GA4 by shape, not host (F20, 2026-10-21; URLs from a real aa.co.nz page load)", () => {
  const TAIL = "gtm=45je6aj0v886025420za20ozb6934724zd6934724xf1&_p=1792528403167&gcd=13l3l3l3l1l1&dma=0&npa=0";
  const urls = {
    sgtm: `https://analytics.aa.co.nz/g/collect?v=2&tid=G-PNYJZGH4F3&${TAIL}&en=page_view&ep.page_location=https%3A%2F%2Fwww.aa.co.nz%2Fmembership%2F`,
    google: `https://analytics.google.com/g/collect?v=2&tid=G-EMQQPZVZVY&${TAIL}&en=page_view`,
    doubleclick: `https://stats.g.doubleclick.net/g/collect?v=2&tid=G-EMQQPZVZVY&cid=1963964415.1792528405&${TAIL}`,
    sCollect: `https://analytics.google.com/g/s/collect?dma=0&npa=0&gcd=13l3l3l3l1l1&gtm=45j91e6aj0v886025420z99168656781za20ozb6934724zd6934724xf1`,
  };

  it("recognises GA4 collect on analytics.google.com, doubleclick and a first-party server-side GTM host", () => {
    for (const [name, url] of Object.entries(urls)) {
      const out = classifyAnalyticsRequest(url, "GET", null);
      expect(out?.kind, name).toBe("beacon");
      if (out?.kind === "beacon") expect(out.dest, name).toBe("ga4");
    }
  });

  it("reads the event, the measurement id and the Consent Mode signals", () => {
    const out = classifyAnalyticsRequest(urls.sgtm, "GET", null);
    if (out?.kind !== "beacon") return expect.unreachable("expected beacon");
    expect(out.events[0]).toMatchObject({ eventName: "page_view", props: { tid: "G-PNYJZGH4F3" } });
    expect(out.tid).toBe("G-PNYJZGH4F3");
    expect(out.consent).toEqual({ gcd: "13l3l3l3l1l1", dma: "0", npa: "0" });
  });

  it("keeps the measurement id and consent signals on a collect request that carries no event", () => {
    const out = classifyAnalyticsRequest(urls.doubleclick, "GET", null);
    if (out?.kind !== "beacon") return expect.unreachable("expected beacon");
    expect(out.events).toHaveLength(0);
    expect(out.tid).toBe("G-EMQQPZVZVY");
    expect(out.consent?.gcd).toBe("13l3l3l3l1l1");
  });

  it("does not treat the sGTM cookie endpoint or Google Ads endpoints as GA4 events", () => {
    const noise = [
      "https://analytics.aa.co.nz/_/set_cookie?val=1pDGAujVRmt6fADmLHKQ",
      "https://www.google.com/ccm/collect?rcb=11&frm=0&apvc=1&ae=g",
      "https://ad.doubleclick.net/ccm/s/collect?auid=274576725.1792528404",
      "https://www.google.co.nz/ads/ga-audiences?v=1&t=sr&tid=G-EMQQPZVZVY",
      "https://analytics.aa.co.nz/_/service_worker/6a60/sw_iframe.html",
      "https://googleads.g.doubleclick.net/pagead/id",
      "https://internal-c.posthog.com/i/v1/logs?ip=0",
      "https://internal-c.posthog.com/api/surveys/?token=x",
      "https://internal-c.posthog.com/s/?ip=1&ver=1.200",
    ];
    for (const url of noise) {
      expect(classifyAnalyticsRequest(url, "GET", null), url).toBeNull();
      expect(isKnownNoise(url), url).toBe(true);
    }
  });

  it("recognises an unknown first-party host by shape (v=2 and a G- tid), but not a look-alike", () => {
    expect(classifyAnalyticsRequest("https://metrics.example.com/g/collect?v=2&tid=G-ABC1234567&en=scroll", "GET", null)?.kind).toBe("beacon");
    expect(classifyAnalyticsRequest("https://example.com/g/collect?foo=1", "GET", null)).toBeNull();
    expect(classifyAnalyticsRequest("https://example.com/g/collect?v=2&foo=1", "GET", null)).toBeNull();
  });

  it("learns a first-party GA4 host, then accepts its collect requests without a tid", () => {
    const opts = { ga4Hosts: new Set(["metrics.example.com"]) };
    expect(classifyAnalyticsRequest("https://metrics.example.com/g/collect?v=2&en=scroll", "GET", null)).toBeNull();
    const out = classifyAnalyticsRequest("https://metrics.example.com/g/collect?v=2&en=scroll", "GET", null, opts);
    expect(out?.kind === "beacon" && out.dest === "ga4").toBe(true);
    expect(classifyAnalyticsRequest("https://other.example.com/g/collect?v=2&en=scroll", "GET", null, opts)).toBeNull();
  });

  it("reads extra events batched in the POST body", () => {
    const body = "en=scroll&epn.percent_scrolled=90\nen=click&ep.link_url=https%3A%2F%2Fx.com";
    const out = classifyAnalyticsRequest("https://analytics.google.com/g/collect?v=2&tid=G-ABC1234567&en=page_view", "POST", body);
    if (out?.kind !== "beacon") return expect.unreachable("expected beacon");
    expect(out.events.map((e) => e.eventName)).toEqual(["page_view", "scroll", "click"]);
    expect(out.events[1]!.props.percent_scrolled).toBe("90");
  });

  it("analyticsLike spots analytics-looking requests and ignores ordinary assets", () => {
    for (const url of [urls.sgtm, urls.google, "https://metrics.example.com/e/?ip=1", "https://x.example.com/a?api_key=abc123456", "https://www.google.com/ccm/collect?x=1"]) {
      expect(analyticsLike(url), url).toBe(true);
    }
    for (const url of [
      "https://cdn.example.com/app.js",
      "https://fonts.googleapis.com/css2?family=Open+Sans",
      "https://example.com/logo.png",
      "https://posthog.com/page-data/sq/d/3244896695.json",
      "https://analytics.example.com/assets/app.json",
    ]) {
      expect(analyticsLike(url), url).toBe(false);
    }
  });
});

describe("parseCspViolation (F10, 2026-10-20)", () => {
  it("extracts the blocked URL and directive from Chrome's console message", () => {
    const text =
      "Loading the script 'https://t.nobodycame.app/static/array.js' violates the following Content Security Policy directive: \"script-src 'self' 'unsafe-inline' https://eu.i.posthog.com\". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.";
    expect(parseCspViolation(text)).toEqual({ blockedUri: "https://t.nobodycame.app/static/array.js", directive: "script-src" });
  });

  it("handles connect-src violations", () => {
    const text =
      "Refused to connect to 'https://t.example.com/e/?ip=1' because it violates the following Content Security Policy directive: \"connect-src 'self'\".";
    expect(parseCspViolation(text)).toEqual({ blockedUri: "https://t.example.com/e/", directive: "connect-src" });
  });

  it("returns null for unrelated console errors", () => {
    expect(parseCspViolation("Uncaught TypeError: x is not a function")).toBeNull();
    expect(parseCspViolation("")).toBeNull();
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
