/**
 * Day 1 setup check for the TAI Labs challenge, OpenRouter edition. Run: npm run challenge:check:openrouter
 * Free checks by default. Add `-- --live` for one tiny real call (about a quarter of a cent, ~25 s) that proves the key works.
 * Mirrors the upstream Python check_setup.py, which only accepts an sk-ant- key.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotenv, resolveOpenRouter, sdkEnv, type EnvSource } from "./env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ICONS = { true: "✓", false: "✗", null: "·" } as const;
interface Result {
  ok: boolean | null;
  message: string;
}

function fileSource(label: string, path: string): EnvSource | null {
  return existsSync(path) ? { name: label, vars: parseDotenv(readFileSync(path, "utf8")) } : null;
}

const sources: EnvSource[] = [
  { name: "process env", vars: process.env },
  fileSource("challenge/.env", join(here, ".env")),
  fileSource("root .env", join(root, ".env")),
].filter((s): s is EnvSource => s !== null);
const resolved = resolveOpenRouter(sources);

function nodeVersion(): Result {
  const major = Number(process.versions.node.split(".")[0]);
  return { ok: major >= 24, message: major >= 24 ? `Node ${process.versions.node}` : `Node ${process.versions.node} is too old; install Node 24 or newer.` };
}

function sdkInstalled(): Result {
  const p = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  return existsSync(p)
    ? { ok: true, message: `Claude Agent SDK ${JSON.parse(readFileSync(p, "utf8")).version} installed` }
    : { ok: false, message: "Claude Agent SDK not found. Run: npm install" };
}

function openRouterKey(): Result {
  return resolved.problems.length === 0
    ? { ok: true, message: `OpenRouter key found in ${resolved.keySource}` }
    : { ok: false, message: resolved.problems[0]! };
}

function gatewayConfig(): Result {
  return { ok: true, message: `Gateway: ANTHROPIC_BASE_URL=${resolved.env.ANTHROPIC_BASE_URL}, ANTHROPIC_API_KEY left empty on purpose` };
}

async function liveCall(): Promise<Result> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let reply = "";
    const started = Date.now();
    // A wrong model name or a dead gateway can hang the child process, so never wait more than 90 s.
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 90_000);
    for await (const m of query({
      prompt: "Reply with the single word OK.",
      options: {
        abortController,
        model: resolved.model,
        maxTurns: 1,
        // No maxBudgetUsd here on purpose: through OpenRouter the CLI sees inflated usage numbers (hundreds of thousands
        // of cache-creation tokens, priced as an unknown model) and stops with "Reached maximum budget ($0.05)" although
        // the real call costs about a quarter of a cent (observed 2026-10-21). Real spend caps belong on the OpenRouter key.
        allowedTools: [],
        // A neutral folder so this repo's own settings, hooks and CLAUDE.md are not loaded into the check.
        cwd: tmpdir(),
        // TypeScript replaces the child environment. sdkEnv keeps PATH, HOME and friends but drops the host app's
        // Claude login and variables, which would otherwise be sent to the gateway instead of the OpenRouter key.
        env: sdkEnv(process.env, resolved.env),
        // Do not load the user's ~/.claude settings, plugins, hooks and MCP servers into the check.
        settingSources: [],
      },
    })) {
      if (m.type === "result" && m.subtype === "success") reply = m.result;
    }
    clearTimeout(timer);
    return reply
      ? { ok: true, message: `Live call worked: "${reply.trim().slice(0, 40)}" in ${Math.round((Date.now() - started) / 1000)} s (the cost the SDK reports is not trustworthy via OpenRouter; check your OpenRouter activity page)` }
      : { ok: false, message: "The call ended without a reply. Try CHALLENGE_MODEL=anthropic/claude-sonnet-5.5." };
  } catch (e) {
    const text = String(e instanceof Error ? e.message : e).replaceAll(resolved.env.ANTHROPIC_AUTH_TOKEN || "\u0000", "***").slice(0, 300);
    return { ok: false, message: `Live call failed: ${text}` };
  }
}

const results: Result[] = [nodeVersion(), sdkInstalled(), openRouterKey(), gatewayConfig()];
if (process.argv.includes("--live")) {
  results.push(resolved.problems.length === 0 ? await liveCall() : { ok: null, message: "Skipped the live call until the key and gateway are fixed." });
} else {
  results.push({ ok: null, message: "Live call skipped (about a quarter of a cent). Prove the key with: npm run challenge:check:openrouter -- --live" });
}
for (const note of resolved.notes) results.push({ ok: null, message: note });

console.log("Checking your setup (OpenRouter)...\n");
for (const r of results) console.log(`  ${ICONS[String(r.ok) as keyof typeof ICONS]} ${r.message}`);
const problems = results.filter((r) => r.ok === false).length;
if (problems > 0) {
  console.error(`\nFix the ✗ line${problems > 1 ? "s" : ""} above, then run this again.`);
  process.exit(1);
}
console.log("\nAll set.");
