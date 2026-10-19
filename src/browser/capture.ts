import type { BeaconEvent, CapturedRequest, ClassifiedRequest, Destination } from "../schemas/evidence";

/**
 * Analytics beacon classification — pure functions so the detection logic is
 * unit-testable and never depends on the browser.
 *
 * Detected on the wire:
 *  - PostHog: POST /e/, /i/v0/e/, /batch, /decide, /decide_v3 (+ snippet posthog.init)
 *  - GA4: google-analytics.com /g/collect or /j/collect (collect?v=2, en= params, gtag.js)
 *  - GTM: googletagmanager.com/gtm.js containers (GTM-*)
 *  - gtag.js: googletagmanager.com/gtag/js (G-*)
 */

const MAX_RAW = 400;

/** A script src is an analytics tag script (not site assets on analytics hosts). */
export function isAnalyticsScriptSrc(src: string): boolean {
  try {
    const u = new URL(src);
    return isAnalyticsScriptUrl(u.hostname.toLowerCase(), u.pathname);
  } catch {
    return false;
  }
}

function isAnalyticsScriptUrl(host: string, path: string): boolean {
  // PostHog: the posthog-js snippet itself, its loader config, and site init
  // wrappers (posthog-init.js) — never unrelated assets on posthog domains.
  const file = decodeURIComponent(path.split("/").pop() ?? "");
  if (host.includes("posthog")) {
    if (/^(posthog|array)(\.min)?\.js$/i.test(file)) return true;
    if (/^posthog-[a-z0-9-]*\.js$/i.test(file)) return true;
    if (/\/array\/[A-Za-z0-9_-]{6,}\/config\.js$/i.test(path)) return true;
    if (/\/static\/(posthog|array)(\.min)?\.js$/i.test(path)) return true;
    return false;
  }
  if (/(^|\.)googletagmanager\.com$/.test(host)) {
    return /^\/gtm\.js$/.test(path) || /^\/gtag\/js/.test(path);
  }
  if (/(^|\.)google-analytics\.com$/.test(host)) {
    return path === "/analytics.js" || path === "/gtag/js";
  }
  return false;
}

/** Classify one network request; null when it is not an analytics request we track. */
export function classifyAnalyticsRequest(
  requestUrl: string,
  method: string,
  postData?: string | null,
): ClassifiedRequest | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // Tag script loads (feed the tag inventory).
  if (isAnalyticsScriptUrl(host, path)) {
    if (/(^|\.)googletagmanager\.com$/.test(host)) {
      if (/^\/gtm\.js$/.test(path)) {
        return { kind: "script", dest: "gtm", src: requestUrl, tagId: u.searchParams.get("id") ?? undefined };
      }
      if (/^\/gtag\/js/.test(path)) {
        const id = u.searchParams.get("id") ?? undefined;
        return { kind: "script", dest: id?.startsWith("G-") ? "gtag" : "gtm", src: requestUrl, tagId: id };
      }
    }
    if (/(^|\.)google-analytics\.com$/.test(host)) {
      return { kind: "script", dest: "ga4", src: requestUrl };
    }
    // PostHog snippet (posthog.js / array.js) or its loader config.
    const arrayToken = path.match(/\/array\/([A-Za-z0-9_-]{6,})\/config\.js$/)?.[1];
    return {
      kind: "script",
      dest: "posthog",
      src: requestUrl,
      tagId: arrayToken ? `array:${arrayToken}` : undefined,
    };
  }

  // PostHog ingestion endpoints.
  if (host.includes("posthog")) {
    if (/^\/(i\/v0\/)?e\/?$/.test(path) || path === "/batch" || path.startsWith("/batch")) {
      return { kind: "beacon", dest: "posthog", events: parsePostHogEvents(postData), raw: truncate(postData) };
    }
    if (path.startsWith("/decide")) {
      // Config endpoint: beacon evidence, but no events to report.
      return { kind: "beacon", dest: "posthog", events: [], raw: truncate(postData) };
    }
    return null;
  }

  // GA4 Measurement Protocol.
  if (/(^|\.)google-analytics\.com$/.test(host)) {
    if (/^\/(g|j)\/collect$/.test(path)) {
      return { kind: "beacon", dest: "ga4", events: parseGa4Collect(u.searchParams), raw: truncate(u.search) };
    }
    if (path === "/collect" || path === "/analytics.js") {
      // Legacy Universal Analytics.
      if (path === "/collect") {
        const events = parseLegacyCollect(u.searchParams, postData);
        if (events) {
          return { kind: "beacon", dest: "other", events, raw: truncate(u.search) };
        }
      }
      return null;
    }
    return null;
  }

  // Some sites proxy GA4/GTM through their own domain; gtag.js still calls
  // google-analytics.com. Nothing else is tracked.
  return null;
}

/** PostHog event JSON: { event, properties } or { batch: [{ event, properties }] }. */
export function parsePostHogEvents(postData?: string | null): BeaconEvent[] {
  const out: BeaconEvent[] = [];
  if (!postData) return out;
  const parsed = tryParse(postData);
  if (!parsed) {
    // Possibly compressed/encoded; record nothing rather than guess.
    return out;
  }
  const single = asRecord(parsed);
  if (single && typeof single.event === "string") {
    out.push({ dest: "posthog", eventName: single.event, props: compactProps(single.properties) });
    return out;
  }
  if (single && Array.isArray(single.batch)) {
    for (const entry of single.batch.slice(0, 25)) {
      const r = asRecord(entry);
      if (r && typeof r.event === "string") {
        out.push({ dest: "posthog", eventName: r.event, props: compactProps(r.properties) });
      }
    }
  }
  return out;
}

/**
 * Resolve PostHog beacon events from any body form posthog-js uses: plain
 * JSON, a raw gzipped body (Content-Encoding: gzip, the 1.4x default), or a
 * JSON envelope with a gzip-base64 payload. Never guesses: undecodable
 * bodies return no events.
 */
export async function resolvePostHogEvents(body: string | Uint8Array | null | undefined): Promise<{ events: BeaconEvent[]; text: string | null }> {
  if (body === null || body === undefined) return { events: [], text: null };
  let text: string | null;
  if (typeof body === "string") {
    text = body;
  } else {
    // Raw gzipped body (magic bytes 0x1f 0x8b).
    if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
      const inflated = await gunzip(body);
      text = inflated;
    } else {
      try {
        text = new TextDecoder().decode(body);
      } catch {
        text = null;
      }
    }
  }
  if (text === null) return { events: [], text: null };
  const direct = parsePostHogEvents(text);
  if (direct.length > 0) return { events: direct, text };
  // gzip-base64 envelope: { compression: "gzip-base64", data: "<base64>" }
  const parsed = tryParse(text);
  const envelope = asRecord(parsed);
  if (envelope && envelope.compression === "gzip-base64" && typeof envelope.data === "string") {
    try {
      const bytes = base64ToBytes(envelope.data);
      const inflated = await gunzip(bytes);
      if (inflated) return { events: parsePostHogEvents(inflated), text: inflated };
    } catch {
      /* fall through */
    }
  }
  return { events: [], text };
}

async function gunzip(data: Uint8Array): Promise<string | null> {
  try {
    const DS = (globalThis as unknown as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    if (!DS) return null;
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("gzip"));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

function base64ToChars(input: string): Uint8Array {
  // atob is available in Workers and Node.
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const base64ToBytes = base64ToChars;

/** GA4 /collect query params: en (event name), ep.* (params), tid (property). */
export function parseGa4Collect(params: URLSearchParams): BeaconEvent[] {
  const en = params.get("en");
  if (!en) return [];
  const props: Record<string, unknown> = {};
  const tid = params.get("tid");
  if (tid) props.tid = tid;
  for (const [k, v] of params.entries()) {
    if (k.startsWith("ep.") || k.startsWith("epn.")) {
      const propKey = k.replace(/^epn?\./, "");
      props[propKey] = v.length > 120 ? v.slice(0, 120) + "…" : v;
    }
  }
  return [{ dest: "ga4", eventName: en, props }];
}

/** Legacy Universal Analytics collect (v=1): ec/ea/el hit params. */
export function parseLegacyCollect(params: URLSearchParams, _postData?: string | null): BeaconEvent[] | null {
  const tid = params.get("tid") ?? "";
  if (!tid.startsWith("UA-") && params.get("v") !== "1") return null;
  const ec = params.get("ec") ?? "";
  const ea = params.get("ea") ?? "";
  if (!ec && !ea) return null;
  return [
    {
      dest: "other",
      eventName: [ec, ea].filter(Boolean).join("_") || "legacy_collect",
      props: { tid: tid || undefined, hitType: params.get("t") ?? undefined },
    },
  ];
}

/** Build the evidence payload for one captured beacon. */
export function beaconEvidencePayload(capture: CapturedRequest): Record<string, unknown> {
  const c = capture.classified;
  if (c.kind === "script") {
    return { scriptSrc: c.src, tagId: c.tagId ?? null, method: capture.method, note: "tag script load" };
  }
  return {
    requestUrl: redactUrl(capture.requestUrl),
    method: capture.method,
    events: c.events.map((e) => ({ eventName: e.eventName, props: e.props })),
    ...(c.raw ? { raw: c.raw } : {}),
  };
}

/** The single event name a beacon carries (first parsed event), if any. */
export function firstEventName(classified: ClassifiedRequest): string | null {
  return classified.kind === "beacon" && classified.events.length > 0 ? classified.events[0].eventName : null;
}

/** Destination label for evidence rows. */
export function destOf(classified: ClassifiedRequest): Destination {
  return classified.kind === "beacon" ? classified.dest : classified.dest;
}

/** Strip query strings and PII-ish values from stored URLs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return truncate(url) ?? url;
  }
}

function compactProps(value: unknown): Record<string, unknown> {
  const r = asRecord(value);
  if (!r) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r).slice(0, 30)) {
    const key = k.length > 60 ? k.slice(0, 60) + "…" : k;
    if (v === null || typeof v !== "object") {
      const s = String(v ?? "");
      out[key] = s.length > 160 ? s.slice(0, 160) + "…" : v;
    } else {
      try {
        const s = JSON.stringify(v);
        out[key] = s.length > 160 ? s.slice(0, 160) + "…" : JSON.parse(s);
      } catch {
        out[key] = String(v).slice(0, 160);
      }
    }
  }
  return out;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // posthog-js sometimes sends urlencoded form data.
    try {
      const params = new URLSearchParams(text);
      const data = params.get("data") ?? params.get("batch");
      if (data) return JSON.parse(data);
    } catch {
      /* fall through */
    }
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function truncate(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  return s.length > MAX_RAW ? s.slice(0, MAX_RAW) + "…" : s;
}

/** Truncate a resolved body for evidence payloads. */
export function truncateRaw(s: string | null | undefined): string | undefined {
  return truncate(s);
}
