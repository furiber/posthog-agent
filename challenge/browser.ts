/**
 * The tool's hands: load one page in local Chromium and record what the network and the page did. All judgement lives in
 * core.ts (summarizeCapture); this file only observes. Not unit-tested (it needs a browser); the live run and
 * `npm run parity` exercise it.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { RawCapture } from "./core.ts";

/** Reuse an already-installed Playwright Chromium (no download); override with PARITY_CHROME=path. */
export function findChrome(): string | undefined {
  if (process.env.PARITY_CHROME) return process.env.PARITY_CHROME;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(process.env.LOCALAPPDATA ?? "", "ms-playwright"), join(homedir(), ".cache", "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright")].filter((r): r is string => Boolean(r));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const exe of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        if (existsSync(join(root, dir, exe))) return join(root, dir, exe);
      }
    }
  }
  return undefined;
}

const TAG_SCRIPT = /gtm\.js|gtag\/js|array\.js|posthog|analytics\.js/i;

export async function capturePage(url: string): Promise<RawCapture> {
  const executablePath = findChrome();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
  try {
    const page = await (await browser.newContext()).newPage();
    const requests: RawCapture["requests"] = [];
    const scriptStatuses: RawCapture["scriptStatuses"] = [];
    const consoleErrors: string[] = [];
    page.on("request", (r) => requests.push({ url: r.url(), method: r.method(), ...(r.postData() ? { postData: r.postData()!.slice(0, 5000) } : {}) }));
    page.on("response", (r) => {
      if (TAG_SCRIPT.test(r.url()) && scriptStatuses.length < 30) scriptStatuses.push({ src: r.url().slice(0, 200), status: r.status() });
    });
    page.on("console", (m) => {
      if (m.type() === "error" && consoleErrors.length < 20) consoleErrors.push(m.text().slice(0, 500));
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Settle: network idle (capped), scroll to mid and bottom, dwell, so lazily loaded tags and scroll events get a fair chance.
    await page.waitForTimeout(2_500);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    for (const f of [0.5, 1]) {
      await page.evaluate((fraction) => window.scrollTo(0, Math.floor(document.body.scrollHeight * fraction)), f);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1_500);

    const runtime = await page.evaluate(() => {
      const w = window as unknown as { google_tag_manager?: Record<string, unknown>; dataLayer?: unknown[]; gtag?: unknown; posthog?: { capture?: unknown; __loaded?: boolean } };
      const keys = Object.keys(w.google_tag_manager ?? {});
      return {
        gtmContainers: keys.filter((k) => /^GTM-/.test(k)),
        gtagIds: keys.filter((k) => /^G-/.test(k)),
        dataLayerLength: Array.isArray(w.dataLayer) ? w.dataLayer.length : null,
        gtag: typeof w.gtag === "function",
        posthog: w.posthog && typeof w.posthog.capture === "function" ? (w.posthog.__loaded ? ("loaded" as const) : ("stub" as const)) : ("absent" as const),
      };
    });
    return { url, finalUrl: page.url(), title: await page.title(), settled: true, requests, consoleErrors, runtime, scriptStatuses };
  } finally {
    await browser.close();
  }
}
