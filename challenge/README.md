# TAI Labs challenge workspace

Our entry for the TAI Labs "Build Your First AI Agent with the Claude Agent SDK" challenge (19 to 23 Oct 2026) lives in this folder. The upstream reference repo is cloned next to it for local use.

## Upstream reference (not committed)

`challenge/upstream/` is a sparse clone of https://github.com/akshika47/AI-Internship (folder `claude-agent-sdk-challenge` only). It is git-ignored on purpose: the upstream repo has no licence, so we do not redistribute it. To recreate it on a new machine:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/akshika47/AI-Internship.git challenge/upstream
cd challenge/upstream && git sparse-checkout set claude-agent-sdk-challenge
```

## Day 1 definition of done: `check_setup.py` is all green

```sh
npm run challenge:check
```

It runs the upstream check from its own folder (`uv run python -X utf8 check_setup.py`; `-X utf8` is needed on Windows so the ✓ and ✗ characters print).

What it checks, and what "green" needs:

| Check | Needs |
|---|---|
| Python 3.10+ | `uv` (installed); it fetches Python 3.12 itself |
| Claude Agent SDK installed | handled by `uv run` (pinned in the upstream `pyproject.toml`) |
| API key | `ANTHROPIC_API_KEY` in `challenge/upstream/claude-agent-sdk-challenge/.env` (copy of `.env.example`), with API credit at platform.claude.com. A Claude subscription does not cover the API. |
| CV | optional note, shown as `·`, not a failure |

The key is the only manual step: open the `.env` file above and replace `sk-ant-...` with your key. Never commit it (`.env` is git-ignored).

Note: the upstream check looks for a `.env` from the current folder upwards, so the challenge `.env` must exist in `claude-agent-sdk-challenge/`; otherwise it picks up this project's own `.env`.
