/**
 * Use an OpenRouter key for the Claude Agent SDK (OpenRouter's documented Anthropic-compatible path):
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api   (no /v1)
 *   ANTHROPIC_AUTH_TOKEN=<OpenRouter key>          (sent as a bearer token)
 *   ANTHROPIC_API_KEY=                             (must be explicitly empty)
 * The key is read from process env or a .env file and mapped in memory; it is never copied to another file or printed.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
/**
 * Claude Code only accepts its own model names (haiku, sonnet, opus); a slug like anthropic/claude-haiku-5.5 passed
 * as the model is "unrecognized" and the call hangs. So the SDK gets the role name, and ANTHROPIC_DEFAULT_<ROLE>_MODEL
 * maps each role to an OpenRouter slug (checked against openrouter.ai/api/v1/models on 2026-10-21).
 */
export const MODEL_SLUGS = {
  haiku: "anthropic/claude-haiku-5.5",
  sonnet: "anthropic/claude-sonnet-5.5",
  opus: "anthropic/claude-opus-5.5",
} as const;
/** The setup check uses the cheapest role. Override a role's slug with CHALLENGE_HAIKU_MODEL, CHALLENGE_SONNET_MODEL or CHALLENGE_OPUS_MODEL. */
export const DEFAULT_MODEL = "haiku";

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * The environment for the SDK's Claude Code child process. The TypeScript SDK replaces the child's environment with
 * what we pass, so build it explicitly: inherit everything EXCEPT Claude/Anthropic credentials and host-app variables
 * (inside the Claude desktop app these make the child send the app's own OAuth login token instead of our key), then apply ours.
 */
const INHERITED_CLAUDE_VARS = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|ENABLE_CLAUDEAI_)/;
export function sdkEnv(inherited: Record<string, string | undefined>, ours: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inherited)) {
    if (v !== undefined && !INHERITED_CLAUDE_VARS.test(k)) out[k] = v;
  }
  return {
    ...out,
    ...ours,
    // Keep the run to what we asked for: no claude.ai connectors, no auto memory from the user's profile.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
}

export interface EnvSource {
  name: string;
  vars: Record<string, string | undefined>;
}

export interface OpenRouterResolution {
  /** Variables to give the SDK's Claude Code process (spread over process.env). */
  env: Record<string, string>;
  model: string;
  /** Where the key came from, e.g. "root .env (OPENROUTER_API_KEY)"; never the key itself. */
  keySource: string | null;
  problems: string[];
  notes: string[];
}

export function resolveOpenRouter(sources: EnvSource[]): OpenRouterResolution {
  const problems: string[] = [];
  const notes: string[] = [];
  let token = "";
  let keySource: string | null = null;
  for (const s of sources) {
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY"]) {
      if (!token && s.vars[name]) {
        token = s.vars[name]!;
        keySource = `${s.name} (${name})`;
      }
    }
  }
  const first = (name: string) => sources.map((s) => s.vars[name]).find((v) => v);

  if (!token) {
    problems.push("No OpenRouter key found. Set OPENROUTER_API_KEY (or ANTHROPIC_AUTH_TOKEN) in challenge/.env or the repo's .env.");
  } else if (/\.\.\.$/.test(token)) {
    problems.push(`The key in ${keySource} is still a placeholder (ends in "..."). Replace it with your OpenRouter key.`);
  } else if (!token.startsWith("sk-or-")) {
    problems.push(`The key in ${keySource} does not look like an OpenRouter key (they start with sk-or-).`);
  }

  // The endpoint is always forced to OpenRouter below, so a different value (for example one the desktop app
  // injects into child processes) is harmless: say so instead of failing.
  const base = first("ANTHROPIC_BASE_URL");
  if (base && !/^https:\/\/openrouter\.ai\/api\/?$/i.test(base)) {
    notes.push(`Ignoring ANTHROPIC_BASE_URL=${base}; this project always uses ${OPENROUTER_BASE_URL}${/\/v1\/?$/.test(base) ? " (no /v1)" : ""}.`);
  }

  const slug = (role: keyof typeof MODEL_SLUGS) => first(`CHALLENGE_${role.toUpperCase()}_MODEL`) ?? MODEL_SLUGS[role];
  notes.push(`Model: ${DEFAULT_MODEL} role, routed to ${slug("haiku")} (sonnet: ${slug("sonnet")})`);
  return {
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: slug("haiku"),
      ANTHROPIC_DEFAULT_SONNET_MODEL: slug("sonnet"),
      ANTHROPIC_DEFAULT_OPUS_MODEL: slug("opus"),
      CLAUDE_CODE_SUBAGENT_MODEL: slug("sonnet"),
      // OpenRouter's Anthropic endpoint answers 400 invalid_union to the CLI's tool_reference blocks (tool search) and
      // newest beta flags, and the CLI then retries silently for minutes. Verified 2026-10-21 with SDK 0.3.305.
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    },
    model: DEFAULT_MODEL,
    keySource,
    problems,
    notes,
  };
}
