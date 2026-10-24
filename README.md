# kairo

[![CI](https://github.com/Shikaru0/kairo/actions/workflows/ci.yml/badge.svg)](https://github.com/Shikaru0/kairo/actions/workflows/ci.yml)
[![Publish to GitHub Packages](https://github.com/Shikaru0/kairo/actions/workflows/npm-publish-github-packages.yml/badge.svg)](https://github.com/Shikaru0/kairo/actions/workflows/npm-publish-github-packages.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Shikaru0/kairo)](https://github.com/Shikaru0/kairo/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Packages](https://img.shields.io/github/package-json/v/Shikaru0/kairo?label=packages)](https://github.com/Shikaru0/kairo/pkgs/npm/kairo)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A minimal terminal coding agent built on [Bun](https://bun.sh). Kairo runs locally with [Ollama](https://ollama.com) or any OpenAI-compatible host, keeps its context lean with automatic compaction, self-reviews its work, and extends itself with plugins, MCP servers, subagents, missions, and custom commands.

## Features

- **Local-first** — Native Ollama support with thinking; works with OpenAI, OpenRouter, vLLM, LM Studio, Groq, and any `/chat/completions` host
- **Configurable providers & models** — Define everything in `kairo.json` with per-provider and per-model settings
- **Self-reviewing** — A critic pass checks completed tool-assisted turns before returning them
- **Smart context management** — Tool output spilling, trimming, and deep compaction keep long sessions running
- **Built-in tools** — `read`, `write`, `edit`, `grep`, `glob`, `bash`, `todo`, `task`, `bg`, `websearch`, `webfetch`, and plugin/MCP tools
- **Subagents** — Built-in `general-purpose`, `explore`, `plan`, or define your own with tool restrictions and custom models
- **Autonomous missions** — DAG-based task decomposition that runs independent work in parallel
- **Custom commands** — Define slash commands as TypeScript or Markdown prompt templates
- **Plugin system** — [Agent Plugins](https://agent-plugins.org) 1.0.0 support with skills, MCP (`stdio`/`streamable-http`), and AGENTS.md
- **AGENTS.md aware** — Reads `./AGENTS.md` and `~/.config/kairo/AGENTS.md` (Claude Code, Codex, OpenCode compatible)

## Requirements

- [Bun](https://bun.sh) >= 1.2
- [Ollama](https://ollama.com) running locally (default) or an API key for a hosted OpenAI-compatible provider

## Quickstart

```bash
# Install dependencies
bun install

# Pull a model with Ollama
ollama pull qwen3.5:4b

# Start Kairo
bun run dev
```

Kairo starts in the current directory with session `default`. Use `bun run dev <session>` for named sessions.

## Slash commands

| Command | Description |
| --- | --- |
| `/help` | Show available commands |
| `/new` | Start a fresh session |
| `/clear` | Clear conversation history |
| `/history` | Show conversation history |
| `/use <id>` | Load a saved session |
| `/save <id>` | Save session to a named ID |
| `/model` or `/model <provider>/<model>` | List models or switch model/provider |
| `/provider` or `/provider <name> [model]` | List providers or switch provider |
| `/agents` | List available subagents |
| `/commands` | List custom slash commands |
| `/plugins` | List loaded plugins, skills, tools, and MCP instructions |
| `/ls` | List files in the current directory |
| `/compact` | Force conversation compaction |
| `/usage` or `/stats` | Show token usage for the session |
| `/exit` | Exit Kairo |

## Providers & Configuration

Kairo is configured with `kairo.json`. It loads from:

1. `~/.config/kairo/kairo.json` (user)
2. `./kairo.json` (project) — overrides and deep-merges with the user config

A default `kairo.json` is included in the repo. Invalid files are reported and skipped without crashing.

```json
{
  "model": "ollama/qwen3.5:4b",
  "providers": {
    "ollama": {
      "api": "ollama",
      "baseURL": "http://127.0.0.1:11434",
      "context": 65536,
      "models": {
        "qwen3.5:4b": { "name": "Qwen 3.5 4B" },
        "llama3.2:3b": {}
      }
    },
    "openrouter": {
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "models": {
        "anthropic/claude-sonnet-4": { "name": "Sonnet 4", "context": 200000 },
        "meta-llama/llama-3.3-70b-instruct": { "temperature": 0.7, "thinking": false }
      }
    }
  }
}
```

- **api**: `ollama` for Ollama's native API, or `openai` for any `/chat/completions` host (defaults to `ollama` for provider named `ollama`, otherwise `openai`)
- **baseURL**: Host endpoint
- **apiKey**: Bearer token. Use `${VAR}` to read from environment variables (keeps secrets out of committed files)
- **context**: Context window in tokens. Ollama bakes this into each request via `num_ctx`
- **models**: Per-model overrides for `name`, `context`, `temperature`, and `thinking` (`true`, `false`, `"low"`, `"medium"`, `"high"`)

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `KAIRO_CONFIG` | — | Path to a specific config file (overrides default locations) |
| `KAIRO_PROVIDER` | `ollama` | Provider to use at startup |
| `KAIRO_MODEL` | `qwen3.5:4b` | Model at startup, or `provider/model` to switch providers |
| `KAIRO_CONTEXT` | config value | Context window in tokens, overrides config |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | — | API key (local hosts often don't need one) |
| `KAIRO_PLUGINS` | — | Extra plugin directories, colon-separated |
| `KAIRO_SEARCH` | `exa` | Set to `ddg` to force DuckDuckGo |
| `EXA_API_KEY` | — | Raises Exa search rate limits |
| `XDG_CONFIG_HOME` | `~/.config` | Config directory location |
| `XDG_DATA_HOME` | `~/.local/share` | Data directory location |

## Built-in tools

| Tool | Description |
| --- | --- |
| `read` | Read file contents (line-numbered) |
| `write` | Write/create files |
| `edit` | Edit files with exact string replacement |
| `grep` | Search file contents with regex |
| `glob` | Find files by glob pattern |
| `bash` | Run shell commands |
| `todo` | Track and manage tasks |
| `task` | Spawn a subagent for a focused task |
| `bg` | Run commands in the background |
| `websearch` | Search the web (Exa or DuckDuckGo) |
| `webfetch` | Fetch and read web pages |
| `skill` | Load a plugin skill on demand |

## Subagents

Kairo ships with three built-in subagents and supports custom ones.

**Built-in:**
- `general-purpose` — Full tool access for complex multi-step work
- `explore` — Read-only exploration with `glob`, `grep`, `read`, web tools
- `plan` — Research and create implementation plans without making changes

**Custom agents** can be defined as `.md` (with frontmatter) or `.json` files in:

1. `./.kairo/agents/` (project, highest priority)
2. `./agents/`
3. `~/.config/kairo/agents/`
4. `~/.config/opencode/agents/`
5. `~/.claude/agents/`

```markdown
---
name: debugger
description: Debugging specialist for errors and test failures
tools: glob,grep,read,bash
model: ollama/qwen3.5:4b
temperature: 0.3
thinking: medium
---
You are an expert debugger. Find root cause, apply minimal fixes, verify with tests.
```

Call subagents via the `task` tool with `subagent: "debugger"`, or let the agent choose automatically.

## Missions (autonomous task DAGs)

The `mission` tool breaks large goals into a DAG of dependent tasks and runs them in parallel when possible.

**Actions:** `create`, `run`, `status`, `list`, `clear`

```json
{
  "action": "create",
  "goal": "Refactor auth module",
  "tasks": [
    { "id": "explore", "title": "Explore auth", "description": "...", "subagent": "explore" },
    { "id": "plan", "title": "Plan changes", "description": "...", "deps": ["explore"], "subagent": "plan" },
    { "id": "impl", "title": "Implement", "description": "...", "deps": ["plan"] }
  ]
}
```

```json
{ "action": "run", "missionId": "m0" }
{ "action": "status", "missionId": "m0" }
```

Tasks with satisfied dependencies run concurrently via subagents. Progress and results are tracked in the mission status.

## Custom slash commands

Define your own commands that expand to prompts or run custom TypeScript logic.

**Locations (first match wins):**
1. `./.kairo/commands/`
2. `./commands/`
3. `~/.config/kairo/commands/`
4. `~/.config/opencode/commands/`
5. `~/.claude/commands/`

**Markdown prompt template** (`.kairo/commands/review.md`):
```markdown
---
name: review
description: Review code for bugs and improvements
---
Review $ARGUMENTS for bugs, security issues, and suggest concrete improvements.
```

Use with `/review src/auth.ts`. Use `$ARGUMENTS`, `$1`, `$2`... for positional args.

**TypeScript command** (`.kairo/commands/deploy.ts`):
```ts
export default {
  name: "deploy",
  description: "Deploy the project",
  run: async (ctx) => {
    ctx.print("Deploying...");
    await ctx.chat.send("Run the deployment steps");
  },
};
```

## Plugins

Kairo loads [Agent Plugins](https://agent-plugins.org) 1.0.0 packages from:

1. `./.kairo/plugins/<plugin>/` — project plugins (shadow user plugins with the same name)
2. `~/.config/kairo/plugins/<plugin>/` — user plugins
3. Directories in `KAIRO_PLUGINS` (colon-separated)

A plugin directory contains `plugin.json`, optional `skills/<name>/SKILL.md`, optional `mcp.json`, and optional `AGENTS.md`. Skills appear in the catalog and load on demand via the `skill` tool. MCP servers (`stdio`, `streamable-http`) become tools named `server_tool`. Server instructions and plugin AGENTS.md are injected into the system prompt. Broken plugins are skipped with notes; use `/plugins` to inspect what's loaded.

## Project context & AGENTS.md

Kairo reads `~/.config/kairo/AGENTS.md` and `./AGENTS.md` (same format as Claude Code, Codex, and OpenCode). The user's file comes first, the project's second. Each is capped at 32 KB. Plugin AGENTS.md files are also included in the prompt. Loose skills are discovered from `.kairo/skill(s)`, `.agents/skills`, `.claude/skills`, and their user-level equivalents.

At startup, Kairo captures a snapshot of the project (directory tree, git branch/status, package scripts) and includes it in context.

## Sessions

Conversations are auto-saved to `.kairo-sessions/`. Use `/save <id>` and `/use <id>` to manage sessions, or start a named session with `bun run dev <id>`. Sessions are gitignored by default.

## Development

```bash
# Run in dev mode
bun run dev

# Type check
bunx tsc --noEmit

# Run tests
bun test
```

## License

[MIT](LICENSE)
