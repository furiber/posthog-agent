import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, agentOptions, sameSite, summarizeCapture, type RawCapture } from "../challenge/core.ts";

const TAIL = "gtm=45je6aj0v886025420za20ozb6934724zd6934724xf1&_p=1792528403167&gcd=13l3l3l3l1l1&dma=0&npa=0";
const req = (url: string, method = "GET", postData?: string) => ({ url, method, ...(postData ? { postData } : {}) });
const runtime = (over: Record<string, unknown> = {}) => ({ gtmContainers: [], gtagIds: [], dataLayerLength: null, gtag: false, posthog: "absent" as const, ...over });

const aa: RawCapture = {
  url: "https://www.aa.co.nz/membership",
  finalUrl: "https://www.aa.co.nz/membership/",
  title: "AA Membership",
  settled: true,
  requests: [
    req("https://www.googletagmanager.com/gtm.js?id=GTM-KVZFV7"),
    req("https://www.googletagmanager.com/gtag/js?id=G-PNYJZGH4F3&cx=c"),
    req("https://www.googletagmanager.com/gtag/js?id=G-EMQQPZVZVY&cx=c"),
    req(`https://analytics.aa.co.nz/g/collect?v=2&tid=G-PNYJZGH4F3&${TAIL}&en=page_view`),
    req(`https://analytics.google.com/g/collect?v=2&tid=G-EMQQPZVZVY&${TAIL}&en=page_view`),
    req("https://analytics.aa.co.nz/_/set_cookie?val=abc"),
    req("https://www.google.com/ccm/collect?rcb=11"),
    req("https://www.aa.co.nz/assets/app.js"),
  ],
  consoleErrors: [],
  runtime: runtime({ gtmContainers: ["GTM-KVZFV7"], dataLayerLength: 3 }),
  scriptStatuses: [
    { src: "https://www.googletagmanager.com/gtag/js?id=G-PNYJZGH4F3&cx=c", status: 200 },
    { src: "https://www.googletagmanager.com/gtag/js?id=G-EMQQPZVZVY&cx=c", status: 200 },
  ],
};

describe("summarizeCapture: the one tool the agent gets (challenge Day 1, 2026-10-21)", () => {
  it("reports tags with a proven state, the events seen and the Consent Mode signals", () => {
    const s = summarizeCapture(aa);
    const gtag = s.tags.find((t) => t.destination === "gtag");
    expect(gtag).toMatchObject({ state: "loaded_and_firing" });
    expect(gtag?.detail).toContain("G-PNYJZGH4F3");
    expect(s.tags.find((t) => t.destination === "gtm")).toMatchObject({ state: "loaded_and_firing" });
    expect(s.beacons.find((b) => b.destination === "ga4")).toMatchObject({ events: ["page_view"], tids: ["G-PNYJZGH4F3", "G-EMQQPZVZVY"] });
    expect(s.consent).toEqual({ gcd: "13l3l3l3l1l1", dma: "0", npa: "0" });
  });

  it("does not list plumbing or ordinary assets as unrecognised traffic", () => {
    expect(summarizeCapture(aa).unrecognised).toEqual([]);
  });

  it("lists analytics-looking requests it could not classify, so the agent cannot call a page silent by mistake", () => {
    const s = summarizeCapture({ ...aa, requests: [...aa.requests, req("https://metrics.example.com/collect?x=1")] });
    expect(s.unrecognised.map((u) => u.url)).toEqual(["https://metrics.example.com/collect"]);
  });

  it("marks a PostHog tag blocked when the browser reported a CSP violation, and says why", () => {
    const s = summarizeCapture({
      url: "https://nobodycame.app/",
      finalUrl: "https://nobodycame.app/",
      title: "Nobody Came",
      settled: true,
      requests: [req("https://t.nobodycame.app/static/array.js")],
      consoleErrors: [
        "Loading the script 'https://t.nobodycame.app/static/array.js' violates the following Content Security Policy directive: \"script-src 'self' https://eu.i.posthog.com\". The action has been blocked.",
        "Uncaught TypeError: unrelated",
      ],
      runtime: runtime({ posthog: "stub" }),
      scriptStatuses: [],
    });
    expect(s.tags[0]).toMatchObject({ destination: "posthog", state: "blocked" });
    expect(s.csp).toEqual([{ blockedUri: "https://t.nobodycame.app/static/array.js", directive: "script-src" }]);
    expect(s.beacons).toEqual([]);
  });

  it("returns no tags and an explicit note for a page with no analytics", () => {
    const s = summarizeCapture({ ...aa, requests: [req("https://www.aa.co.nz/assets/app.js")], runtime: runtime(), scriptStatuses: [] });
    expect(s.tags).toEqual([]);
    expect(s.note).toMatch(/no analytics/i);
  });

  it("says what each third-party host was recognised as, so the model does not call a recognised sGTM host unclassified", () => {
    const s = summarizeCapture(aa);
    expect(s.thirdPartyHosts.find((h) => h.host === "analytics.aa.co.nz")).toMatchObject({ classifiedAs: ["ga4"] });
    expect(s.thirdPartyHosts.find((h) => h.host === "analytics.google.com")).toMatchObject({ classifiedAs: ["ga4"] });
    expect(s.thirdPartyHosts.find((h) => h.host === "www.google.com")?.classifiedAs).toEqual([]);
  });

  it("lists the busiest third-party hosts without query strings or secrets", () => {
    const s = summarizeCapture(aa);
    expect(s.thirdPartyHosts[0]).toMatchObject({ host: "www.googletagmanager.com", requests: 3 });
    expect(s.thirdPartyHosts.map((h) => h.host)).toContain("analytics.aa.co.nz");
    expect(JSON.stringify(s)).not.toContain("val=abc");
  });
});

describe("sameSite: the agent may only visit the site it was asked about (prompt-injection guard)", () => {
  it("allows the same host, with or without www", () => {
    expect(sameSite("https://aa.co.nz/", "https://www.aa.co.nz/membership")).toBe(true);
    expect(sameSite("https://www.aa.co.nz/", "https://aa.co.nz/x")).toBe(true);
  });

  it("refuses other domains, look-alikes, subdomain tricks and non-http schemes", () => {
    for (const bad of ["https://evil.com/", "https://aa.co.nz.evil.com/", "https://notaa.co.nz/", "javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      expect(sameSite("https://www.aa.co.nz/", bad), bad).toBe(false);
    }
  });
});

describe("agentOptions: a locked-down Claude Agent SDK run through OpenRouter", () => {
  const server = { name: "audit" } as never;
  const o = agentOptions({
    server,
    inherited: { PATH: "x", CLAUDE_CODE_OAUTH_TOKEN: "leak" },
    openRouterEnv: { ANTHROPIC_AUTH_TOKEN: "sk-or-v1-abc" },
  });

  it("allows only the audit tool, denies everything else, and loads no user settings", () => {
    expect(o.allowedTools).toEqual(["mcp__audit__capture_page"]);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual([]);
    for (const t of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"]) expect(o.disallowedTools).toContain(t);
    expect(o.mcpServers).toHaveProperty("audit");
  });

  it("caps turns, uses the sonnet role, and builds a sanitised environment", () => {
    expect(o.maxTurns).toBe(6);
    expect(o.model).toBe("sonnet");
    expect(o.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(o.env?.PATH).toBe("x");
    expect(o.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-abc");
  });

  it("gives the model rules that forbid claiming what tool results do not show", () => {
    expect(SYSTEM_PROMPT).toMatch(/only (state|report|claim)[^.]*tool results?/i);
    expect(SYSTEM_PROMPT).toMatch(/same site|only visit/i);
    expect(SYSTEM_PROMPT).toMatch(/instructions? (found )?in (web )?pages? (are|is) data|never follow instructions/i);
  });
});
