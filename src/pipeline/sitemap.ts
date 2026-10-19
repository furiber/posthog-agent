/**
 * sitemap_discover implementation: read sitemap.xml (and sitemap indexes),
 * fall back to linked-page BFS over fetched HTML. Deterministic: sorted,
 * deduped, capped at the page budget, entry URL first. Second runs with the
 * same input visit the same URLs.
 */

export interface DiscoveryResult {
  pages: string[];
  source: "sitemap" | "bfs";
  truncated: boolean;
  notes: string;
}

const SKIP_EXT = /\.(pdf|zip|rar|7z|gz|tar|png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|mp4|mp3|avi|webm|woff2?|ttf|eot|dmg|exe|apk)(\?|$)/i;

export async function discoverPages(
  url: string,
  pageBudget: number,
  log?: (msg: string) => void,
): Promise<DiscoveryResult> {
  const entry = normalize(url);
  const origin = new URL(entry).origin;

  // 1) sitemap.xml (following one level of sitemap indexes, capped).
  try {
    const sitemapUrls = [`${origin}/sitemap.xml`];
    const locs: string[] = [];
    let indexFetches = 0;
    while (sitemapUrls.length > 0 && locs.length < pageBudget * 3 && indexFetches < 5) {
      const sitemapUrl = sitemapUrls.shift();
      if (!sitemapUrl) break;
      indexFetches += 1;
      const xml = await fetchText(sitemapUrl, 10_000);
      if (xml === null) continue;
      if (/<sitemapindex/i.test(xml)) {
        for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          if (sitemapUrls.length < 5) sitemapUrls.push(m[1]);
        }
        continue;
      }
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        locs.push(m[1]);
      }
    }
    const pages = dedupe(
      locs.map((l) => normalize(l)).filter((l) => l.startsWith(origin) && !SKIP_EXT.test(l)),
    );
    if (pages.length > 0) {
      log?.(`sitemap: ${pages.length} same-origin URLs`);
      const finalList = withEntryFirst(pages, entry, pageBudget);
      return {
        pages: finalList,
        source: "sitemap",
        truncated: pages.length > finalList.length,
        notes: `sitemap.xml at ${origin}`,
      };
    }
    log?.("sitemap: no usable same-origin URLs; falling back to link BFS");
  } catch (e) {
    log?.(`sitemap: failed (${String(e).slice(0, 120)}); falling back to link BFS`);
  }

  // 2) Linked-page BFS over fetched HTML.
  const visited = new Set<string>([entry]);
  const queue: string[] = [entry];
  const found: string[] = [entry];
  let truncated = false;
  while (queue.length > 0 && found.length < pageBudget) {
    const current = queue.shift();
    if (!current) break;
    const html = await fetchText(current, 10_000);
    if (html === null) continue;
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#\s]+)["']/gi)) {
      const href = resolveUrl(m[1], current);
      if (!href || !href.startsWith(origin)) continue;
      if (SKIP_EXT.test(href) || href === current) continue;
      if (visited.has(href)) continue;
      visited.add(href);
      if (found.length >= pageBudget) {
        truncated = true;
        break;
      }
      found.push(href);
      queue.push(href);
    }
  }
  return {
    pages: withEntryFirst(found.sort(), entry, pageBudget),
    source: "bfs",
    truncated,
    notes: "no usable sitemap; linked-page BFS from the entry URL",
  };
}

function withEntryFirst(pages: string[], entry: string, budget: number): string[] {
  const list = pages.filter((p) => p !== entry).slice(0, Math.max(0, budget - 1));
  return [entry, ...list];
}

function normalize(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  if (u.pathname.endsWith("/") && u.pathname !== "/") u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function resolveUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return normalize(u.toString());
  } catch {
    return null;
  }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)].sort();
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": "analytics-audit-agent/0.1 (+https://developers.cloudflare.com/)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text|xml|html/i.test(type)) return null;
    const text = await res.text();
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch {
    return null;
  }
}
