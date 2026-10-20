import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, MODEL_SLUGS, OPENROUTER_BASE_URL, parseDotenv, resolveOpenRouter, sdkEnv } from "../challenge/env.ts";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const src = (name: string, vars: Record<string, string | undefined>) => ({ name, vars });

describe("resolveOpenRouter: use an OpenRouter key for the Claude Agent SDK (2026-10-21)", () => {
  it("maps OPENROUTER_API_KEY to the three variables OpenRouter documents, with ANTHROPIC_API_KEY explicitly empty", () => {
    const r = resolveOpenRouter([src("root .env", { OPENROUTER_API_KEY: KEY })]);
    expect(r.problems).toEqual([]);
    expect(r.env).toMatchObject({ ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: "" });
    expect(r.keySource).toBe("root .env (OPENROUTER_API_KEY)");
  });

  it("turns off the Claude Code features OpenRouter rejects (observed 2026-10-21: 400 invalid_union on tool_reference blocks; the CLI then retries for minutes)", () => {
    const r = resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY })]);
    expect(r.env.ENABLE_TOOL_SEARCH).toBe("false");
    expect(r.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
  });

  it("routes Claude Code's model roles to OpenRouter slugs (a slug passed as the model name is rejected as unrecognised and hangs)", () => {
    const r = resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY })]);
    expect(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(MODEL_SLUGS.haiku);
    expect(r.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(MODEL_SLUGS.sonnet);
    expect(r.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(MODEL_SLUGS.opus);
    expect(r.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(MODEL_SLUGS.sonnet);
    expect(MODEL_SLUGS.haiku).toMatch(/^anthropic\/claude-haiku/);
  });

  it("prefers earlier sources, and ANTHROPIC_AUTH_TOKEN over OPENROUTER_API_KEY", () => {
    const other = "sk-or-v1-ffffffffffffffffffffffffffffffff";
    const r = resolveOpenRouter([src("process env", { ANTHROPIC_AUTH_TOKEN: other }), src("root .env", { OPENROUTER_API_KEY: KEY })]);
    expect(r.env.ANTHROPIC_AUTH_TOKEN).toBe(other);
    expect(r.keySource).toBe("process env (ANTHROPIC_AUTH_TOKEN)");
  });

  it("reports a missing key, a placeholder, and a non-OpenRouter key", () => {
    expect(resolveOpenRouter([src("root .env", {})]).problems[0]).toMatch(/no OpenRouter key/i);
    expect(resolveOpenRouter([src("x", { OPENROUTER_API_KEY: "sk-or-..." })]).problems[0]).toMatch(/placeholder/i);
    expect(resolveOpenRouter([src("x", { OPENROUTER_API_KEY: "sk-ant-api03-abcdefghijklmnop" })]).problems[0]).toMatch(/sk-or-/);
  });

  it("never puts the key into problems, notes or the key source", () => {
    const r = resolveOpenRouter([src("root .env", { OPENROUTER_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1" })]);
    const shown = JSON.stringify({ p: r.problems, n: r.notes, s: r.keySource });
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain("0123456789abcdef");
  });

  it("overrides a wrong base URL instead of failing, and says so (the desktop app can inject its own)", () => {
    for (const base of ["https://openrouter.ai/api/v1", "https://api.anthropic.com"]) {
      const r = resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY, ANTHROPIC_BASE_URL: base })]);
      expect(r.problems).toEqual([]);
      expect(r.env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_BASE_URL);
      expect(r.notes.join(" ")).toContain(`Ignoring ANTHROPIC_BASE_URL=${base}`);
    }
    expect(resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://openrouter.ai/api" })]).notes.join(" ")).not.toMatch(/Ignoring/);
  });

  it("checks with the cheap haiku role, and lets CHALLENGE_<ROLE>_MODEL change a role's OpenRouter slug", () => {
    expect(resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY })]).model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("haiku");
    const r = resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY, CHALLENGE_HAIKU_MODEL: "anthropic/claude-haiku-4.5" })]);
    expect(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("anthropic/claude-haiku-4.5");
    expect(r.notes.join(" ")).toContain("anthropic/claude-haiku-4.5");
  });
});

describe("sdkEnv: never leak the host app's Claude login to the gateway (found 2026-10-21)", () => {
  // Inside the Claude desktop app the SDK child inherits CLAUDE_CODE_* host-auth variables and sends the app's own
  // OAuth bearer token instead of ANTHROPIC_AUTH_TOKEN, so an OpenRouter key was ignored and a login token went to the gateway.
  const inherited = {
    PATH: "C:\\bin",
    HOME: "C:\\Users\\x",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret",
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
    CLAUDE_CODE_MESSAGING_TOKEN: "t",
    CLAUDECODE: "1",
    CLAUDE_AGENT_SDK_VERSION: "0.3.304",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_API_KEY: "sk-ant-api03-leak",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-other",
  };

  it("drops every inherited Claude/Anthropic credential and host variable, keeps the rest, then applies ours", () => {
    const r = resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY })]);
    const env = sdkEnv(inherited, r.env);
    expect(env.PATH).toBe("C:\\bin");
    expect(env.HOME).toBe("C:\\Users\\x");
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE", "CLAUDE_AGENT_SDK_VERSION"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_BASE_URL);
    expect(JSON.stringify(env)).not.toContain("sk-ant-");
  });

  it("also isolates from user plugins, claude.ai connectors and auto memory", () => {
    const env = sdkEnv({}, resolveOpenRouter([src("x", { OPENROUTER_API_KEY: KEY })]).env);
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
});

describe("parseDotenv", () => {
  it("reads KEY=value lines, ignoring comments, blanks and surrounding quotes", () => {
    const text = '# comment\n\nA=1\nB="two words"\nC=\'x\'\nD = spaced \nE=\n';
    expect(parseDotenv(text)).toEqual({ A: "1", B: "two words", C: "x", D: "spaced", E: "" });
  });
});
