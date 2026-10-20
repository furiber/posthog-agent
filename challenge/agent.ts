/**
 * Challenge Day 1: a first Claude Agent SDK agent. Run: npm run challenge:agent -- https://www.aa.co.nz/membership
 * It reads a website and says which analytics tags it has, whether they load and fire, and what is wrong, using one tool
 * (capture_page) backed by a real browser. Runs through OpenRouter (see challenge/README.md for why the setup looks the way it does).
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { capturePage } from "./browser.ts";
import { agentOptions, sameSite, summarizeCapture, TOOL_NAME } from "./core.ts";
import { resolveOpenRouter } from "./env.ts";
import { loadSources } from "./sources.ts";

const args = process.argv.slice(2);
const target = args.find((a) => /^https?:\/\//.test(a));
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!target) {
  console.error("usage: npm run challenge:agent -- <https://site> [--max-turns 6] [--model sonnet|haiku]");
  process.exit(2);
}

const resolved = resolveOpenRouter(loadSources());
if (resolved.problems.length > 0) {
  console.error(`Setup problem: ${resolved.problems[0]}\nRun: npm run challenge:check:openrouter`);
  process.exit(1);
}

const MAX_PAGES = 3;
let visited = 0;
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

const capture = tool(
  "capture_page",
  "Load one page of the site in a real browser and return what its analytics did: tags with a proven state, requests that fired, Consent Mode signals, CSP blocks, unrecognised traffic.",
  { url: z.string().describe("Absolute URL of a page on the site being audited") },
  async ({ url }) => {
    if (!sameSite(target, url)) return text(`Refused: ${url} is not on the site being audited (${new URL(target).hostname}).`, true);
    if (visited >= MAX_PAGES) return text(`Refused: page limit of ${MAX_PAGES} reached.`, true);
    visited += 1;
    try {
      return text(JSON.stringify(summarizeCapture(await capturePage(url)), null, 2));
    } catch (e) {
      return text(`Could not load ${url}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  },
);
const server = createSdkMcpServer({ name: "audit", version: "1.0.0", tools: [capture] });

// Wall-clock guard: maxBudgetUsd is unreliable through OpenRouter, so cap turns and time instead.
const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), 240_000);
const started = Date.now();
const token = resolved.env.ANTHROPIC_AUTH_TOKEN;
const mask = (s: string) => s.replaceAll(token, "***");

console.log(`Auditing ${target} (model role: ${flag("--model") ?? "sonnet"}, max turns: ${flag("--max-turns") ?? 6})\n`);
let turns = 0;
let answer = "";
try {
  for await (const m of query({
    prompt: `Audit the analytics setup of ${target}`,
    options: agentOptions({
      server,
      inherited: process.env,
      openRouterEnv: resolved.env,
      maxTurns: flag("--max-turns") ? Number(flag("--max-turns")) : undefined,
      model: flag("--model"),
      abortController,
    }),
  })) {
    if (m.type === "assistant") {
      turns += 1;
      for (const block of m.message.content) {
        if (block.type === "tool_use" && block.name === TOOL_NAME) console.log(`  → capture_page(${(block.input as { url?: string }).url})`);
      }
    }
    if (m.type === "result") {
      if (m.subtype === "success") answer = m.result;
      else console.error(`\nRun ended: ${m.subtype}`);
    }
  }
} catch (e) {
  console.error(`\nRun failed: ${mask(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
} finally {
  clearTimeout(timer);
}

console.log(`\n${answer || "(no answer)"}\n`);
console.log(`— ${turns} model turn(s), ${visited} page(s) captured, ${Math.round((Date.now() - started) / 1000)} s. Real cost: check your OpenRouter activity page.`);
process.exit(answer ? 0 : 1);
