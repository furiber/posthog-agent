import type { Evidence } from "../schemas/evidence";
import type { TagInventoryItem, TagState } from "../schemas/report";

/**
 * F21: do the tags load, and do they fire? A pure function over captured evidence.
 * Inputs: tag script evidence, `loadcheck` evidence (window objects, script response
 * statuses, whether the page settled), beacons, and CSP / failed-request diagnostics.
 * Silence is only reported as "loaded but not firing" after the page fully settled.
 */

interface Runtime {
  gtmContainers: string[];
  gtagIds: string[];
  dataLayerLength: number | null;
  gtag: boolean;
  posthog: "absent" | "stub" | "loaded";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
}

function mergeRuntime(checks: Evidence[]): Runtime {
  const out: Runtime = { gtmContainers: [], gtagIds: [], dataLayerLength: null, gtag: false, posthog: "absent" };
  const rank = { absent: 0, stub: 1, loaded: 2 } as const;
  for (const c of checks) {
    const r = (c.payload.runtime ?? {}) as Partial<Runtime>;
    out.gtmContainers.push(...(r.gtmContainers ?? []));
    out.gtagIds.push(...(r.gtagIds ?? []));
    if (typeof r.dataLayerLength === "number") out.dataLayerLength = Math.max(out.dataLayerLength ?? 0, r.dataLayerLength);
    out.gtag = out.gtag || Boolean(r.gtag);
    if (r.posthog && rank[r.posthog] > rank[out.posthog]) out.posthog = r.posthog;
  }
  return out;
}

export function computeTagStates(items: TagInventoryItem[], evidence: Evidence[]): TagInventoryItem[] {
  const cap = evidence.filter((e) => e.source === "capture");
  const checks = cap.filter((e) => e.payload.loadcheck === true);
  const settled = checks.some((e) => e.payload.settled === true);
  const rt = mergeRuntime(checks);
  const statuses = checks.flatMap((e) => records(e.payload.scriptStatuses).map((s) => ({ src: String(s.src), status: Number(s.status) })));
  const beacons = cap.filter((e) => e.kind === "beacon");
  const diag = cap.filter((e) => e.kind === "dom" && ("cspViolations" in e.payload || "failedAnalyticsRequests" in e.payload));
  const blocks = diag.flatMap((e) => [
    ...records(e.payload.cspViolations).map((v) => ({ uri: String(v.blockedUri), why: `blocked by the page's Content-Security-Policy (${String(v.directive)})` })),
    ...records(e.payload.failedAnalyticsRequests).map((v) => ({ uri: String(v.url), why: `request failed (${String(v.failure)})` })),
  ]);
  const tidOf = (b: Evidence) => str(b.payload.tid) ?? str((b.payload.props as Record<string, unknown> | undefined)?.tid);

  return items.map((item) => {
    const own = cap.filter((e) => item.evidenceIds.includes(e.id));
    const hosts = new Set(
      own.flatMap((e) => [hostOf(str(e.payload.scriptSrc)), str(e.payload.tagId)?.match(/→\s*(\S+)/)?.[1] ?? null]).filter((h): h is string => Boolean(h)),
    );
    const inlineOnly = own.length > 0 && own.every((e) => !str(e.payload.scriptSrc));
    const ids = [...new Set(item.detail.match(/\b(?:G|GTM)-[A-Z0-9]+\b/g) ?? [])];
    const set = (state: TagState, stateDetail: string): TagInventoryItem => ({ ...item, state, stateDetail });
    const scriptOk = (match: (src: string) => boolean) => statuses.some((s) => s.status > 0 && s.status < 400 && match(s.src));
    const relevantBlock = (extra: RegExp) => blocks.find((b) => {
      const h = hostOf(b.uri);
      return Boolean(h) && (hosts.has(h!) || extra.test(h!));
    });

    if (item.destination === "posthog") {
      if (beacons.some((b) => b.dest === "posthog")) return set("loaded_and_firing", "PostHog requests were captured");
      const block = relevantBlock(/posthog/);
      if (block) return set("blocked", `PostHog ${block.why}`);
      const ok = scriptOk((src) => hosts.has(hostOf(src) ?? ""));
      if (rt.posthog === "stub" && ok) return set(settled ? "loaded_not_firing" : "unknown", "the script loaded but the library did not initialise (window.posthog is still the loader stub)");
      if (rt.posthog === "loaded" || ok) return set(settled ? "loaded_not_firing" : "unknown", settled ? "library present, no request captured after the page settled" : "the crawl ended before the page settled");
      return inlineOnly ? set("referenced_not_loaded", "only an init call in the page was seen; no script or library loaded") : set("unknown", "no proof the script loaded");
    }

    if (item.destination === "gtag" || item.destination === "ga4") {
      const measureIds = ids.filter((id) => id.startsWith("G-"));
      const fires = (id: string) => beacons.some((b) => tidOf(b) === id);
      if (measureIds.length > 0) {
        const firing = measureIds.filter(fires);
        const silent = measureIds.filter((id) => !fires(id));
        if (firing.length === measureIds.length) return set("loaded_and_firing", `requests captured for ${firing.join(", ")}`);
        if (firing.length > 0) return set("partially_firing", `${firing.join(", ")} fire; ${silent.join(", ")} not observed`);
      } else if (beacons.some((b) => b.dest === "ga4" || b.dest === "gtag")) {
        return set("loaded_and_firing", "GA4 requests were captured");
      }
      const block = relevantBlock(/googletagmanager|google-analytics|analytics\.google/);
      if (block) return set("blocked", `the tag ${block.why}`);
      const loaded = rt.gtag || measureIds.some((id) => rt.gtagIds.includes(id) || scriptOk((src) => src.includes(`id=${id}`)));
      if (loaded) return set(settled ? "loaded_not_firing" : "unknown", settled ? "the tag loaded, no request captured after the page settled" : "the crawl ended before the page settled");
      return inlineOnly ? set("referenced_not_loaded", "only an inline reference was seen; no script or runtime object") : set("unknown", "no proof the tag loaded");
    }

    if (item.destination === "gtm") {
      const loaded = ids.length > 0 ? ids.some((id) => rt.gtmContainers.includes(id) || scriptOk((src) => src.includes(`id=${id}`))) : rt.gtmContainers.length > 0;
      if (loaded) {
        const busy = (rt.dataLayerLength ?? 0) > 1 || beacons.length > 0;
        if (busy) return set("loaded_and_firing", `container loaded, dataLayer length ${rt.dataLayerLength ?? "?"}`);
        return set(settled ? "loaded_not_firing" : "unknown", settled ? "container loaded but the dataLayer stayed idle" : "the crawl ended before the page settled");
      }
      const block = relevantBlock(/googletagmanager/);
      if (block) return set("blocked", `the container ${block.why}`);
      return inlineOnly ? set("referenced_not_loaded", "only an inline snippet was seen; the container never loaded") : set("unknown", "no proof the container loaded");
    }

    return set("unknown", "no load check for this destination");
  });
}
