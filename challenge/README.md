# TAI Labs challenge workspace

Our entry for the TAI Labs "Build Your First AI Agent with the Claude Agent SDK" challenge (19 to 23 Oct 2026) lives in this folder. The upstream reference repo is cloned next to it for local use.

## Day 1 definition of done: a setup check that is all green

There are two ways to be green. Pick one key.

| | Anthropic key | OpenRouter key (what we use) |
|---|---|---|
| Command | `npm run challenge:check` (the upstream Python `check_setup.py`) | `npm run challenge:check:openrouter` |
| Key | `sk-ant-…` in `challenge/upstream/claude-agent-sdk-challenge/.env`, with API credit at platform.claude.com | `OPENROUTER_API_KEY` (`sk-or-…`) in the repo's `.env` or `challenge/.env`; nothing is copied or printed |
| Proves the key | on your first real run | `npm run challenge:check:openrouter -- --live` (one tiny call, about a quarter of a cent) |

The upstream check only accepts an `sk-ant-` key, so it stays red with OpenRouter by design. Ours checks the same things for the OpenRouter path: Node 24, the TypeScript Agent SDK installed, the key present and shaped like an OpenRouter key, the gateway settings, and optionally a live call.

### Upstream reference (not committed)

`challenge/upstream/` is a sparse clone of https://github.com/akshika47/AI-Internship (folder `claude-agent-sdk-challenge` only). It is git-ignored on purpose: the upstream repo has no licence, so we do not redistribute it. To recreate it on a new machine:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/akshika47/AI-Internship.git challenge/upstream
cd challenge/upstream && git sparse-checkout set claude-agent-sdk-challenge
```

On Windows the upstream check needs `-X utf8` or it crashes printing ✓ and ✗; `npm run challenge:check` adds it.

## Using the Claude Agent SDK through OpenRouter: what we learned (2026-10-21)

OpenRouter documents this path (Anthropic-compatible endpoint). `challenge/env.ts` builds the environment; reuse it in the agent. What it does and why, each verified by running it:

1. **Three variables:** `ANTHROPIC_BASE_URL=https://openrouter.ai/api` (no `/v1`), `ANTHROPIC_AUTH_TOKEN=<OpenRouter key>`, and `ANTHROPIC_API_KEY` explicitly empty.
2. **Do not inherit the host's Claude login.** Inside the Claude desktop app the SDK child process inherits `CLAUDE_CODE_*` variables and sends the app's own OAuth token (`sk-ant-oat…`) as the bearer instead of your key. `sdkEnv()` strips every inherited `ANTHROPIC_*`, `CLAUDE_CODE_*` and related variable before applying ours. In the TypeScript SDK the `env` option replaces the child's environment, so this must be explicit. Symptom without it: OpenRouter answers `401 Missing Authentication header` and the CLI retries about ten times, which looks like a hang.
3. **Isolate from your own setup:** `settingSources: []`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Otherwise your `~/.claude` plugins, hooks, MCP servers and memory load into every run (about 23,000 prompt tokens and 15 to 25 s for a one-word reply; isolated it takes about 3 s).
4. **Models:** pass a role name (`haiku`, `sonnet`, `opus`), and map each role to an OpenRouter slug with `ANTHROPIC_DEFAULT_<ROLE>_MODEL` (we use `anthropic/claude-haiku-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5`; override with `CHALLENGE_<ROLE>_MODEL`). Passing a slug as the model name makes the CLI log "unrecognized model".
5. **Turn off what OpenRouter rejects:** `ENABLE_TOOL_SEARCH=false` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Without them OpenRouter returns `400 invalid_union` on `tool_reference` blocks and the CLI retries silently for minutes (SDK 0.3.305).
6. **Do not rely on `maxBudgetUsd`.** The CLI sees inflated usage numbers from OpenRouter and stops with "Reached maximum budget ($0.05)" on a call that costs about a quarter of a cent. Use `maxTurns`, a wall-clock timeout (we abort after 90 s) and a spend limit on the OpenRouter key itself.
7. Claude Code may not work correctly with non-Anthropic models; stay on `anthropic/…` slugs.

## Files

| File | Purpose |
|---|---|
| `challenge/env.ts` | resolves the OpenRouter key and builds the SDK environment (pure, unit-tested in `test/challengeEnv.test.ts`) |
| `challenge/check.ts` | the OpenRouter setup check, run by `npm run challenge:check:openrouter` |
