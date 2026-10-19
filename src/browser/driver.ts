import { chromium, launch, type BrowserWorker } from "@cloudflare/playwright";

/**
 * Browser driver pool over @cloudflare/playwright.
 *
 * - Production: `launch(env.BROWSER)` — Cloudflare Browser Rendering binding,
 *   the crawl runs natively on Workers.
 * - Local dev (`cf dev`): standard Playwright — `chromium.launch()` from the
 *   same package, against the same tool interface.
 *
 * Multiple contexts may run in parallel (tool-level concurrency, capped by
 * crawlParallelism); this is one browser, never separate agent sessions.
 */

type Browser = Awaited<ReturnType<typeof launch>>;
type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
type Page = Awaited<ReturnType<BrowserContext["newPage"]>>;

export type { Page, BrowserContext };

/** A page that stays open across multiple tool calls; `close()` releases the pool slot. */
export interface PageSession {
  page: Page;
  close(): Promise<void>;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly binding: BrowserWorker | undefined,
    private readonly parallelism: number,
    private readonly onLog?: (msg: string) => void,
  ) {}

  /** Open a page in a fresh context, capped to parallelism; the caller must close it. */
  async openSession(): Promise<PageSession> {
    await this.acquireSlot();
    let context: BrowserContext | null = null;
    try {
      const browser = await this.ensureBrowser();
      context = await browser.newContext();
      const page = await context.newPage();
      let closed = false;
      return {
        page,
        close: async () => {
          if (closed) return;
          closed = true;
          await context!.close().catch(() => {});
          this.releaseSlot();
        },
      };
    } catch (e) {
      if (context) await context.close().catch(() => {});
      this.releaseSlot();
      throw e;
    }
  }

  /** Run fn with a fresh page (in a fresh context), capped to parallelism. */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const session = await this.openSession();
    try {
      return await fn(session.page);
    } finally {
      await session.close();
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (!this.launching) this.launching = this.launchBrowser();
    this.browser = await this.launching;
    return this.browser;
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.binding) {
      try {
        this.onLog?.("browser: launching via Browser Rendering binding");
        return await launch(this.binding);
      } catch (e) {
        this.onLog?.(`browser: binding launch failed (${String(e).slice(0, 120)}); falling back to local Playwright`);
      }
    } else {
      this.onLog?.("browser: no BROWSER binding; launching local Playwright chromium");
    }
    // Standard Playwright local fallback (local dev).
    return (await chromium.launch({ headless: true })) as unknown as Browser;
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.parallelism) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.launching = null;
    if (b) await b.close().catch(() => {});
  }
}
