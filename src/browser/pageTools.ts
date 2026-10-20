import type { CapturedRequest, InteractionKind } from "../schemas/evidence";
import { classifyAnalyticsRequest, parseCspViolation, redactUrl, resolvePostHogEvents, truncateRaw } from "./capture";
import type { BrowserPool, Page } from "./driver";

/**
 * Deterministic page work used by the crawler tools:
 * navigate + capture analytics beacons, inspect the DOM for tag scripts and
 * consent state, and fire scripted interactions. All model-free.
 */

export interface DomInspection {
  title: string;
  scripts: { src: string | null; note: string }[];
  initCalls: string[];
  dataLayer: string[] | null;
  consent: { banner: string | null; api: string | null };
  /** First-party scripts whose body calls posthog.init(...) (a renamed loader such as /ph.js). */
  posthogInitScripts: { src: string; snippet: string }[];
  /** window.posthog state: the loader stub or the loaded library. */
  posthogRuntime: { loaded: boolean; apiHost: string | null } | null;
}

export interface InteractionResult {
  stepId: string;
  preset: string;
  detail: string;
  fired: CapturedRequest[];
}

/** Collects every analytics request seen from a page, with stable capture IDs.
 * Bodies (including gzipped PostHog payloads) are resolved at drain time —
 * postData() is not always available at request-event time — so beacons are
 * never misread as empty. */
export class CaptureCollector {
  private seq = 0;
  private readonly pending: {
    captureId: string;
    pageUrl: string;
    timestamp: string;
    requestUrl: string;
    method: string;
    bodyBuffer: () => Uint8Array | null;
    bodyText: () => string | null;
  }[] = [];
  private readonly resolved = new Map<string, CapturedRequest>();
  /** First-party hosts learned to serve PostHog (asset path seen, or posthog.init api_host). */
  readonly posthogHosts = new Set<string>();
  /** Console CSP violations and failed analytics requests, per page URL (F10). */
  private readonly diag = new Map<string, { csp: { blockedUri: string; directive: string }[]; failed: { url: string; failure: string }[] }>();

  private diagFor(pageUrl: string) {
    let d = this.diag.get(pageUrl);
    if (!d) {
      d = { csp: [], failed: [] };
      this.diag.set(pageUrl, d);
    }
    return d;
  }

  /** Deduplicated diagnostics collected for a page; empty arrays when nothing went wrong. */
  diagnosticsFor(pageUrl: string): { cspViolations: { blockedUri: string; directive: string }[]; failedAnalyticsRequests: { url: string; failure: string }[] } {
    const d = this.diag.get(pageUrl);
    const uniq = <T,>(items: T[]) => [...new Map(items.map((i) => [JSON.stringify(i), i])).values()].slice(0, 10);
    return { cspViolations: uniq(d?.csp ?? []), failedAnalyticsRequests: uniq(d?.failed ?? []) };
  }

  learnHost(host: string | undefined): void {
    if (host) this.posthogHosts.add(host.toLowerCase());
  }

  /** Attach a request listener to a page. Never throws. */
  attach(page: Page, pageUrl: string): void {
    try {
      page.on("console", (msg: { type: () => string; text: () => string }) => {
        try {
          if (msg.type() !== "error") return;
          const v = parseCspViolation(msg.text());
          if (v) this.diagFor(pageUrl).csp.push(v);
        } catch {
          /* diagnostics must never break the crawl */
        }
      });
      page.on("requestfailed", (req: { url: () => string; method: () => string; failure: () => { errorText: string } | null }) => {
        try {
          if (!classifyAnalyticsRequest(req.url(), req.method(), null, { posthogHosts: this.posthogHosts })) return;
          this.diagFor(pageUrl).failed.push({ url: redactUrl(req.url()), failure: req.failure()?.errorText ?? "unknown" });
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* console/requestfailed events unavailable in this driver: skip diagnostics */
    }
    try {
      page.on("request", (req: {
        url: () => string;
        method: () => string;
        postData: () => string | null;
        postDataBuffer?: () => Uint8Array | null;
      }) => {
        try {
          const classified = classifyAnalyticsRequest(req.url(), req.method(), null, { posthogHosts: this.posthogHosts });
          if (!classified) return;
          if (classified.kind === "script" && classified.dest === "posthog") this.learnHost(new URL(req.url()).hostname);
          this.seq += 1;
          this.pending.push({
            captureId: `C${this.seq}`,
            pageUrl,
            timestamp: new Date().toISOString(),
            requestUrl: req.url(),
            method: req.method(),
            bodyBuffer: () => {
              try {
                return typeof req.postDataBuffer === "function" ? (req.postDataBuffer() ?? null) : null;
              } catch {
                return null;
              }
            },
            bodyText: () => safePostData(req),
          });
        } catch {
          /* a capture error must never break the crawl */
        }
      });
    } catch {
      /* request events unavailable in this driver: degrade to DOM-only capture */
    }
  }

  /** Resolve a pending capture's body (once, gzipped bodies included). */
  private async resolve(entry: (typeof this.pending)[number]): Promise<CapturedRequest | null> {
    const cached = this.resolved.get(entry.captureId);
    if (cached) return cached;
    let bodyText: string | null;
    try {
      bodyText = entry.bodyText();
    } catch {
      bodyText = null;
    }
    let classified = classifyAnalyticsRequest(entry.requestUrl, entry.method, bodyText, { posthogHosts: this.posthogHosts });
    if (!classified) return null;
    if (classified.kind === "beacon" && classified.dest === "posthog" && classified.events.length === 0) {
      const bytes = entry.bodyBuffer();
      if (bytes && bytes.length > 0) {
        const { events, text } = await resolvePostHogEvents(bytes);
        if (events.length > 0 || text !== null) {
          classified = { ...classified, events, raw: text === null ? classified.raw : truncateRaw(text) };
        }
      } else if (bodyText !== null) {
        const { events, text } = await resolvePostHogEvents(bodyText);
        if (events.length > 0) {
          classified = { ...classified, events, raw: text === null ? classified.raw : truncateRaw(text) };
        }
      }
    }
    const captured: CapturedRequest = {
      captureId: entry.captureId,
      pageUrl: entry.pageUrl,
      timestamp: entry.timestamp,
      requestUrl: entry.requestUrl,
      method: entry.method,
      classified,
    };
    this.resolved.set(entry.captureId, captured);
    return captured;
  }

  /** All fully-resolved captures so far, in order. */
  async captured(): Promise<CapturedRequest[]> {
    const out: CapturedRequest[] = [];
    for (const entry of this.pending) {
      const c = await this.resolve(entry);
      if (c) out.push(c);
    }
    return out;
  }

  mark(): number {
    return this.pending.length;
  }

  async since(mark: number): Promise<CapturedRequest[]> {
    const out: CapturedRequest[] = [];
    for (let i = mark; i < this.pending.length; i++) {
      const c = await this.resolve(this.pending[i]!);
      if (c) out.push(c);
    }
    return out;
  }
}

/** Navigate to a page and settle; returns the open session plus load-phase captures. */
export async function openPage(
  pool: BrowserPool,
  url: string,
  collector: CaptureCollector,
): Promise<{
  session: import("./driver").PageSession;
  page: Page;
  finalUrl: string;
  title: string;
  complex: boolean;
  loadCaptures: CapturedRequest[];
  tookMs: number;
}> {
  const started = Date.now();
  const session = await pool.openSession();
  const page = session.page;
  collector.attach(page, url);
  try {
    try {
      await page.goto(url, { timeout: 45_000, waitUntil: "domcontentloaded" });
    } catch (e) {
      // SPA / heavy client routing: retry as a complex page.
      try {
        await page.goto(url, { timeout: 45_000, waitUntil: "commit" });
        await page.waitForTimeout(5_000);
      } catch {
        throw e;
      }
    }
    // Let auto-events and tag scripts fire after load.
    await page.waitForTimeout(2_500);
    // A PostHog/GA tag loaded but nothing was sent yet: give the library longer
    // before concluding it is silent (GTM containers may legitimately send nothing).
    const seen = await collector.captured();
    if (
      seen.some((c) => c.classified.kind === "script" && c.classified.dest !== "gtm") &&
      !seen.some((c) => c.classified.kind === "beacon")
    ) {
      await page.waitForTimeout(5_000);
    }
  } catch (e) {
    await session.close();
    throw e;
  }
  const tookMs = Date.now() - started;
  let title = "";
  try {
    title = await page.title();
  } catch {
    /* page might have navigated; keep going */
  }
  let complex = tookMs > 20_000;
  try {
    complex = complex || (await detectComplexity(page));
  } catch {
    /* treat as simple; the retry budget stays at the default */
  }
  return {
    session,
    page,
    finalUrl: safeUrl(page),
    title,
    complex,
    loadCaptures: await collector.captured(),
    tookMs,
  };
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/** Heuristic: is this page an SPA / heavy client-routing app? */
async function detectComplexity(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const html = document.documentElement.outerHTML.slice(0, 200_000);
      const markers = [
        "__NEXT_DATA__",
        "__remixContext",
        "data-reactroot",
        'id="__next"',
        'id="root"',
        "data-server-rendered",
        "nuxt",
        "astro-island",
        "data-sveltekit",
      ];
      return markers.some((m) => html.includes(m));
    });
  } catch {
    return false;
  }
}

/** Extract loaded tag scripts, config/init calls, dataLayer contents, consent state. */
export async function inspectDom(page: Page): Promise<DomInspection> {
  return page.evaluate(async () => {
    const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
    const scripts = Array.from(document.scripts);
    // Renamed first-party loaders (e.g. /ph.js) keep posthog.init in an external
    // script, so inline scanning misses them: read same-origin script bodies.
    const posthogInitScripts: { src: string; snippet: string }[] = [];
    for (const s of scripts.slice(0, 40)) {
      try {
        if (!s.src || new URL(s.src, location.href).origin !== location.origin) continue;
        const text = (await (await fetch(s.src, { credentials: "omit" })).text()).slice(0, 400_000);
        const m = text.match(/posthog\.init\s*\(/);
        if (m) posthogInitScripts.push({ src: s.src, snippet: truncate(text.slice(m.index ?? 0, (m.index ?? 0) + 300), 300) });
      } catch {
        /* unreadable script: skip */
      }
      if (posthogInitScripts.length >= 4) break;
    }
    let posthogRuntime: { loaded: boolean; apiHost: string | null } | null = null;
    try {
      const ph = (window as unknown as { posthog?: { capture?: unknown; __loaded?: boolean; config?: { api_host?: string } } }).posthog;
      if (ph && typeof ph.capture === "function") {
        posthogRuntime = { loaded: Boolean(ph.__loaded), apiHost: ph.config?.api_host ?? null };
      }
    } catch {
      posthogRuntime = null;
    }
    // Same predicate as the wire-side classifier: posthog-js snippets, site
    // init wrappers (posthog-init.js), array loader configs, GTM/gtag/GA
    // scripts — never unrelated assets on analytics hosts.
    const isAnalyticsScript = (src: string): boolean => {
      try {
        const u = new URL(src, location.href);
        const file = decodeURIComponent(u.pathname.split("/").pop() || "").toLowerCase();
        if (u.hostname.includes("posthog")) {
          return (
            /^(posthog|array)(\.min)?\.js$/.test(file) ||
            /^posthog-[a-z0-9-]*\.js$/.test(file) ||
            /\/array\/[A-Za-z0-9_-]{6,}\/config\.js$/.test(u.pathname) ||
            /\/static\/(posthog|array)(\.min)?\.js$/.test(u.pathname)
          );
        }
        if (/(^|\.)googletagmanager\.com$/.test(u.hostname)) {
          return u.pathname === "/gtm.js" || u.pathname.startsWith("/gtag/js");
        }
        if (/(^|\.)google-analytics\.com$/.test(u.hostname)) {
          return u.pathname === "/analytics.js" || u.pathname === "/gtag/js";
        }
        return false;
      } catch {
        return false;
      }
    };
    const interesting = scripts
      .map((s) => ({
        src: s.src || null,
        text: s.src ? null : s.textContent || "",
      }))
      .filter(
        (s) =>
          (s.src && isAnalyticsScript(s.src)) ||
          (!s.src && s.text && /posthog\.init|gtag\s*\(|dataLayer|googletagmanager|posthog-js|GTM-[A-Z0-9]+|G-[A-Z0-9]{6,}/i.test(s.text)),
      )
      .slice(0, 12)
      .map((s) => ({ src: s.src, note: s.src ? "tag script src" : truncate(s.text || "", 300) }));

    const initCalls: string[] = [];
    for (const s of scripts) {
      if (s.src) continue;
      const t = s.textContent || "";
      if (!t) continue;
      for (const m of t.matchAll(/posthog\.init\s*\(/g)) {
        initCalls.push(truncate(t.slice(m.index ?? 0, (m.index ?? 0) + 300), 300));
      }
      for (const m of t.matchAll(/gtag\s*\(\s*['"]config['"]\s*,\s*['"][^'"]+['"]/g)) {
        initCalls.push(m[0]);
      }
      for (const m of t.matchAll(/dataLayer\.push\s*\(/g)) {
        initCalls.push(truncate(t.slice(m.index ?? 0, (m.index ?? 0) + 200), 200));
        if (initCalls.length > 12) break;
      }
      if (initCalls.length > 12) break;
    }

    let dataLayer: string[] | null = null;
    try {
      const w = window as unknown as { dataLayer?: unknown[] };
      if (Array.isArray(w.dataLayer)) {
        dataLayer = w.dataLayer.slice(0, 20).map((x) => {
          try {
            const s = JSON.stringify(x);
            return truncate(s, 300);
          } catch {
            return "[unserializable]";
          }
        });
      }
    } catch {
      dataLayer = null;
    }

    let banner: string | null = null;
    const bannerSelectors = [
      "#onetrust-banner-sdk",
      "#Cookiebot",
      "[data-consent]",
      "[id*='consent' i]",
      "[class*='consent' i]",
      "[class*='cookie' i]",
      "[id*='cookie' i]",
    ];
    for (const sel of bannerSelectors) {
      try {
        if (document.querySelector(sel)) {
          banner = sel;
          break;
        }
      } catch {
        /* invalid selector on this browser; skip */
      }
    }
    let api: string | null = null;
    try {
      const w = window as unknown as Record<string, unknown>;
      if (((w.google_tag_data as Record<string, unknown>) ?? {}).consent) api = "google_tag_data.consent";
      else if (typeof w.__tcfapi === "function") api = "__tcfapi";
      else if (w.ucCmp || w.usercentrics) api = "usercentrics";
      else if (w.UC_UI) api = "usercentrics-ui";
    } catch {
      api = null;
    }

    return {
      title: document.title,
      scripts: interesting,
      initCalls: initCalls.slice(0, 12),
      dataLayer,
      consent: { banner, api },
      posthogInitScripts,
      posthogRuntime,
    };
  });
}

/** Fire one scripted interaction; captures the beacons it fires under a step ID. */
export async function fireInteraction(
  page: Page,
  preset: "cta_click" | "consent_toggle" | "form_submit",
  selector: string | undefined,
  stepId: string,
  collector: CaptureCollector,
): Promise<InteractionResult> {
  const mark = collector.mark();
  let detail = "";
  try {
    if (selector) {
      const loc = page.locator(selector).first();
      await loc.click({ timeout: 6_000 });
      detail = `clicked selector ${selector}`;
    } else if (preset === "cta_click") {
      const target = await findCta(page);
      if (!target) {
        return { stepId, preset, detail: "no visible CTA found (outside nav/header/footer)", fired: [] };
      }
      await target.click({ timeout: 6_000 });
      detail = "clicked a visible CTA";
    } else if (preset === "consent_toggle") {
      const target = await findConsentButton(page);
      if (!target) {
        return { stepId, preset, detail: "no consent banner found", fired: [] };
      }
      await target.click({ timeout: 6_000 });
      detail = "accepted the consent banner";
    } else if (preset === "form_submit") {
      detail = await submitTestForm(page);
    } else {
      return { stepId, preset, detail: "unknown preset", fired: [] };
    }
  } catch (e) {
    detail = `interaction error: ${String(e).slice(0, 160)}`;
  }
  await page.waitForTimeout(1_800);
  return { stepId, preset, detail, fired: await collector.since(mark) };
}

/** Map an interaction step ID to the interaction kind reported in the events table. */
export function interactionFromStepId(stepId: string | undefined): InteractionKind {
  if (!stepId) return "load";
  if (stepId.startsWith("S-click")) return "click";
  if (stepId.startsWith("S-form")) return "form_submit";
  if (stepId.startsWith("S-consent")) return "consent_toggle";
  return "other";
}

type ElementHandleLike = { click: (opts?: { timeout?: number }) => Promise<void> };

async function findCta(page: Page): Promise<ElementHandleLike | null> {
  const handle = await page.evaluateHandle(() => {
    const inChrome = (el: Element) =>
      el.closest("nav, header, footer, [role='navigation']") !== null;
    const els = Array.from(document.querySelectorAll("a, button")).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
      if (inChrome(el)) return false;
      if (!(el.textContent || "").trim()) return false;
      const href = el.getAttribute("href") || "";
      if (href.startsWith("tel:") || href.startsWith("mailto:") || href.startsWith("javascript:")) return false;
      return true;
    });
    return els[0] ?? null;
  });
  const el = handle.asElement();
  return el ? (el as unknown as ElementHandleLike) : null;
}

async function findConsentButton(page: Page): Promise<ElementHandleLike | null> {
  const handle = await page.evaluateHandle(() => {
    const known = ["#onetrust-accept-btn-handler", "#cookiebot-ok", ".cm-btn-success", "[data-accept], .js-accept"];
    for (const sel of known) {
      try {
        const el = document.querySelector(sel);
        if (el instanceof HTMLElement) return el;
      } catch {
        /* skip invalid selector */
      }
    }
    const accept = /(accept|agree|allow|got it|okay|ok|continue|i understand|sure|consent)/i;
    const els = Array.from(document.querySelectorAll("button, a[role='button'], input[type='submit'], [class*='consent' i] button, [id*='consent' i] button")).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const text = (el.textContent || el.getAttribute("value") || "").trim();
      return accept.test(text);
    });
    return els[0] ?? null;
  });
  const el = handle.asElement();
  return el ? (el as unknown as ElementHandleLike) : null;
}

/**
 * Submit a test form: fill only visible (non-honeypot) inputs with harmless
 * test values and submit. Honeypot inputs — hidden, offscreen, zero-size,
 * aria-hidden, or tabindex -1 — are deliberately ignored.
 */
async function submitTestForm(page: Page): Promise<string> {
  const handle = await page.evaluateHandle(() => {
    const forms = Array.from(document.querySelectorAll("form"));
    return (
      forms.find((f) => {
        const action = (f.getAttribute("action") || "").toLowerCase();
        if (action.includes("search") || action.includes("logout") || action.includes("delete")) return false;
        return true;
      }) ?? forms[0] ?? null
    );
  });
  const form = handle.asElement();
  if (!form) return "no form found on the page";

  const filled = await form.evaluate((f: HTMLFormElement) => {
    const honeypot = (input: Element) => {
      if (!(input instanceof HTMLElement)) return true;
      const r = input.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return true;
      const st = getComputedStyle(input);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return true;
      if (input.getAttribute("aria-hidden") === "true") return true;
      if (input.getAttribute("tabindex") === "-1") return true;
      if ((input.className || "").toString().toLowerCase().includes("honeypot")) return true;
      return false;
    };
    let filledCount = 0;
    for (const input of Array.from(f.elements)) {
      if (!(input instanceof HTMLElement)) continue;
      if (input instanceof HTMLInputElement) {
        if (["hidden", "submit", "button", "checkbox", "radio", "file"].includes(input.type)) continue;
        if (honeypot(input)) continue;
        if (input.disabled || input.readOnly) continue;
        const testValue =
          input.type === "email" ? "test@example.com"
          : input.type === "url" ? "https://example.com"
          : input.type === "tel" ? "1234567890"
          : input.type === "number" ? "1"
          : "Test";
        input.value = testValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        filledCount += 1;
      } else if (input instanceof HTMLTextAreaElement) {
        if (honeypot(input) || input.disabled || input.readOnly) continue;
        input.value = "Test";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        filledCount += 1;
      }
    }
    const hasSubmit = !!(f.querySelector("button[type='submit'], input[type='submit']") as HTMLElement | null);
    return { filledCount, hasSubmit, action: f.getAttribute("action") || "(same page)" };
  });

  await form.evaluate((f: HTMLFormElement) => {
    if (typeof f.requestSubmit === "function") {
      try {
        f.requestSubmit();
        return;
      } catch {
        /* fall through to direct submit */
      }
    }
    f.submit();
  });
  return `submitted form (action=${filled.action}, filled=${filled.filledCount} non-honeypot inputs)`;
}

function safePostData(req: { postData: () => string | null }): string | null {
  try {
    return req.postData();
  } catch {
    return null;
  }
}

function safeText(fn: () => string | null): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
