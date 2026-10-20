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

/** Hosts learned at runtime to be first-party proxies: PostHog ingestion, or server-side GTM serving GA4. */
export interface ClassifyOpts {
  posthogHosts?: ReadonlySet<string>;
  ga4Hosts?: ReadonlySet<string>;
}

/** GA4 collect endpoints. Google serves them from several hosts, and sites proxy them through their own. */
const GA4_COLLECT_PATH = /^\/(g|j)\/(s\/)?collect$/;
const GOOGLE_GA4_HOST = /(^|\.)(google-analytics\.com|analytics\.google\.com|g\.doubleclick\.net)$/;
const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]{4,}$/;

/** Google Ads / consent / sGTM plumbing that looks like analytics but carries no GA4 events. */
const NOISE_PATH = /^\/(ccm\/(s\/)?collect|ads\/ga-audiences|pagead\/|activity;|rmkt\/collect|_\/set_cookie|_\/service_worker\/|i\/v1\/logs|api\/surveys|s\/?$)/;

export function isKnownNoise(url: string): boolean {
  try {
    return NOISE_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const ANALYTICS_HOST = /analytics|posthog|googletagmanager|google-analytics|doubleclick|segment\.|mixpanel|amplitude|hotjar|clarity\.ms|plausible|matomo/i;
const ANALYTICS_PATH = /(^|\/)(collect|batch|decide|flags|track|beacon|pixel)(\/|$)|\/(g|j)\/(s\/)?collect|\/e\/?$/i;

/** Why a request looks like analytics traffic (even if we do not recognise it), or null for ordinary assets. */
export function analyticsLikeReason(url: string): string | null {
  try {
    const u = new URL(url);
    if (ANALYTICS_PATH.test(u.pathname)) return "path looks like an analytics endpoint";
    if (u.searchParams.has("tid") || u.searchParams.has("api_key")) return "query carries a measurement id or api key";
    if (ANALYTICS_HOST.test(u.hostname) && !/\.(js|css|json|html|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4)$/i.test(u.pathname)) return "analytics-related host";
    return null;
  } catch {
    return null;
  }
}

export function analyticsLike(url: string): boolean {
  return analyticsLikeReason(url) !== null;
}

/** Consent Mode state Google appends to collect requests (gcd, gcs, dma, npa). */
export function parseConsentSignals(params: URLSearchParams): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of ["gcd", "gcs", "dma", "npa"]) {
    const v = params.get(key);
    if (v !== null) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** PostHog's own asset paths; docs require proxies to forward these, so they identify PostHog on any host. */
const POSTHOG_ASSET_PATH = /^\/static\/(\d[\w.-]*\/)?array\.js$|^\/array\/[A-Za-z0-9_-]{6,}\/config\.js$/;

/** A script src is an analytics tag script (not site assets on analytics hosts). */
export function isAnalyticsScriptSrc(src: string, opts?: ClassifyOpts): boolean {
  try {
    const u = new URL(src);
    return isAnalyticsScriptUrl(u.hostname.toLowerCase(), u.pathname, opts);
  } catch {
    return false;
  }
}

/** Chrome's console message for a Content-Security-Policy block: the blocked URL (query stripped) and the violated directive name. */
export function parseCspViolation(text: string): { blockedUri: string; directive: string } | null {
  if (!/Content Security Policy directive/i.test(text)) return null;
  const uri = text.match(/'((?:https?|wss?):\/\/[^']+)'/)?.[1];
  const directive = text.match(/directive:\s*"([a-z-]+)/i)?.[1];
  return uri && directive ? { blockedUri: redactUrl(uri), directive } : null;
}

/** Pull the api host and a masked token out of a script body that calls posthog.init(...). */
export function parsePostHogInit(text: string): { apiHost?: string; tokenMasked?: string } | null {
  const m = text.match(/posthog\.init\s*\(\s*["']([^"']{6,})["']/);
  if (!m) return null;
  const chunk = text.slice(m.index ?? 0, (m.index ?? 0) + 800);
  const api = chunk.match(/api_host\s*:\s*["']([^"']+)["']/)?.[1];
  let apiHost: string | undefined;
  try {
    apiHost = api ? new URL(api).hostname.toLowerCase() : undefined;
  } catch {
    apiHost = undefined;
  }
  return { ...(apiHost ? { apiHost } : {}), tokenMasked: `${m[1]!.slice(0, 6)}…` };
}

function isAnalyticsScriptUrl(host: string, path: string, opts?: ClassifyOpts): boolean {
  // PostHog: the posthog-js snippet itself, its loader config, and site init
  // wrappers (posthog-init.js) — never unrelated assets on posthog domains.
  const file = decodeURIComponent(path.split("/").pop() ?? "");
  if (POSTHOG_ASSET_PATH.test(path)) return true;
  if (host.includes("posthog") || opts?.posthogHosts?.has(host)) {
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
  opts?: ClassifyOpts,
): ClassifiedRequest | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const posthogHost = host.includes("posthog") || Boolean(opts?.posthogHosts?.has(host));

  // Tag script loads (feed the tag inventory).
  if (isAnalyticsScriptUrl(host, path, opts)) {
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

  // PostHog ingestion endpoints (on posthog domains or a learned first-party proxy).
  if (posthogHost) {
    if (/^\/(i\/v0\/)?e\/?$/.test(path) || path.startsWith("/batch")) {
      return { kind: "beacon", dest: "posthog", events: parsePostHogEvents(postData), raw: truncate(postData) };
    }
    if (path.startsWith("/decide") || path.startsWith("/flags")) {
      // Config endpoints (/flags replaced /decide): beacon evidence, but no events to report.
      return { kind: "beacon", dest: "posthog", events: [], raw: truncate(postData) };
    }
    return null;
  }

  // GA4 Measurement Protocol, recognised by shape: Google's own hosts, a learned first-party
  // (server-side GTM) host, or any host sending v=2 with a G- measurement id.
  if (GA4_COLLECT_PATH.test(path)) {
    const tid = u.searchParams.get("tid") ?? undefined;
    const byShape = u.searchParams.get("v") === "2" && GA4_MEASUREMENT_ID.test(tid ?? "");
    if (GOOGLE_GA4_HOST.test(host) || opts?.ga4Hosts?.has(host) || byShape) {
      const consent = parseConsentSignals(u.searchParams);
      return {
        kind: "beacon",
        dest: "ga4",
        events: parseGa4Collect(u.searchParams, postData),
        raw: truncate(u.search),
        ...(tid ? { tid } : {}),
        ...(consent ? { consent } : {}),
      };
    }
  }

  // Legacy Universal Analytics.
  if (/(^|\.)google-analytics\.com$/.test(host)) {
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
export function parseGa4Collect(params: URLSearchParams, body?: string | null): BeaconEvent[] {
  const tid = params.get("tid");
  const one = (p: URLSearchParams): BeaconEvent | null => {
    const en = p.get("en");
    if (!en) return null;
    const props: Record<string, unknown> = {};
    if (tid) props.tid = tid;
    for (const [k, v] of p.entries()) {
      if (k.startsWith("ep.") || k.startsWith("epn.")) {
        props[k.replace(/^epn?\./, "")] = v.length > 120 ? v.slice(0, 120) + "…" : v;
      }
    }
    return { dest: "ga4", eventName: en, props };
  };
  // The first event rides in the query string; further events are batched in the POST body, one per line.
  const events = [one(params)];
  for (const line of (body ?? "").split(/\r?\n/).slice(0, 25)) {
    if (line.includes("en=")) events.push(one(new URLSearchParams(line)));
  }
  return events.filter((e): e is BeaconEvent => e !== null);
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
    ...(c.tid ? { tid: c.tid } : {}),
    ...(c.consent ? { consentSignals: c.consent } : {}),
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
