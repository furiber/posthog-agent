// Real-browser parity check: does our classifier recognise the analytics traffic a real page produces?
//
//   node scripts/parity.mjs <url> [--wait 10]
//
// Loads the page in local Chromium, records EVERY request, and for each analytics-looking one prints
// whether src/browser/capture.ts recognises it. Exit code 1 when anything analytics-looking is
// unrecognised: that is a classifier bug (for example GA4 on analytics.google.com, 2026-10-21) and
// the URL belongs in a test fixture. Needs Node 24 (runs the .ts import by type stripping).
// Standard playwright-core, not @cloudflare/playwright: the latter imports `cloudflare:` modules and only runs inside workerd.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { analyticsLike, classifyAnalyticsRequest, isKnownNoise } from "../src/browser/capture.ts";

/** Reuse an already-installed Playwright Chromium (no download); override with PARITY_CHROME=path. */
function findChrome() {
  if (process.env.PARITY_CHROME) return process.env.PARITY_CHROME;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(process.env.LOCALAPPDATA ?? "", "ms-playwright"), join(homedir(), ".cache", "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright")].filter(Boolean);
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

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/parity.mjs <url> [--wait seconds]");
  process.exit(2);
}
const waitIdx = process.argv.indexOf("--wait");
const waitMs = (waitIdx > 0 ? Number(process.argv[waitIdx + 1]) : 10) * 1000;

const executablePath = findChrome();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
const page = await (await browser.newContext()).newPage();
const rows = new Map();
const hosts = new Set();
page.on("request", (req) => {
  const u = new URL(req.url());
  hosts.add(u.hostname);
  if (u.hostname === new URL(url).hostname && !classifyAnalyticsRequest(req.url(), req.method(), null)) return; // the page's own assets
  if (!analyticsLike(req.url())) return;
  const classified = classifyAnalyticsRequest(req.url(), req.method(), req.postData());
  const verdict = classified ? `${classified.kind}:${classified.dest}` : isKnownNoise(req.url()) ? "noise" : "UNRECOGNISED";
  const key = `${verdict}  ${req.method()} ${u.hostname}${u.pathname}`;
  rows.set(key, (rows.get(key) ?? 0) + 1);
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(waitMs);
await browser.close();

let bad = 0;
for (const [key, n] of [...rows.entries()].sort()) {
  if (key.startsWith("UNRECOGNISED")) bad += n;
  console.log(`${String(n).padStart(3)}x  ${key}`);
}
console.log(`\n${hosts.size} hosts contacted; ${rows.size} distinct analytics-looking endpoints; ${bad} unrecognised request(s).`);
process.exit(bad > 0 ? 1 : 0);
