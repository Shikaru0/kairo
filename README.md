# kairo

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

## Providers

A provider is the host the model runs on: `ollama` speaks Ollama's own `/api/chat`, `openai` speaks any `/chat/completions` host (OpenAI, OpenRouter, vLLM, LM Studio, Groq). Both are described in `kairo.json`, read from `~/.config/kairo/kairo.json` and then `./kairo.json`; a project file overrides the user's per provider and merges their `models` per id. A file that does not parse is reported and skipped.

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

`api` picks the protocol, `ollama` for a provider named `ollama` and `openai` otherwise. `baseURL` is the host, `apiKey` the bearer token with `${VAR}` read from the environment so a committed file holds no secret, and `context` the window to plan against. A model may set `name` (only a label), its own `context`, `temperature`, and `thinking` (`true`, `false`, `"low"`, `"medium"`, `"high"`; `false` sends no reasoning effort at all).

`/provider` lists providers, `/provider <name> [model]` switches, `/model` lists the configured models and `/model <provider>/<id>` switches both at once. Each provider remembers the model it last ran, so switching back restores it. If the provider named by `KAIRO_PROVIDER` cannot be built, Kairo says why and starts on `ollama`.

## Plugins

Kairo loads [Agent Plugins](https://agent-plugins.org) 1.0.0 packages at startup, from:

1. `./.kairo/plugins/<plugin>/` - project plugins, which shadow a user plugin of the same name
2. `~/.config/kairo/plugins/<plugin>/`
3. every directory in `KAIRO_PLUGINS` (colon-separated)

A package is a directory with a `plugin.json`. Its `skills/<name>/SKILL.md` files are catalogued in the system prompt and loaded on demand through the `skill` tool, and the servers in its `mcp.json` (`stdio` and `streamable-http`) become `server_tool` tools, named the way OpenCode names MCP tools. A server's handshake `instructions` go into the system prompt as well, and so does the package's own `AGENTS.md`, if it has one: standing instructions that belong in every session. A broken package, skill or server is reported and skipped rather than failing the session; `/plugins` lists what loaded and everything that was skipped. Notes are also printed at startup.

Outside any package, Kairo reads `~/.config/kairo/AGENTS.md` and `./AGENTS.md` the same way — the standing-instructions file Claude Code, Codex and OpenCode share. Both are optional; the user's text comes first, then the project's, then the plugins'. Each is capped at 32 KB (a prompt is re-sent every round) and an unreadable or oversized one is reported and ignored. Only the working directory is checked, not its parents.

Loose skills — skills not inside a package — are picked up from the same directories OpenCode and Claude Code read, project first: `.kairo/skill`, `.kairo/skills`, `.agents/skills`, `.claude/skills`, then the user-level `~/.config/kairo/{skill,skills}`, `~/.agents/skills` and `~/.claude/skills`. A name collision keeps the first found and reports the shadowed one.

## Agents

Kairo supports specialized subagents via the `task` tool. Built-in agents: `general-purpose`, `explore`, `plan`. Custom agents can be defined as `.md` (frontmatter) or `.json` files in:

1. `./.kairo/agents/` - project agents
2. `./agents/`
3. `~/.config/kairo/agents/`
4. `~/.config/opencode/agents/`
5. `~/.claude/agents/`

Example (`.kairo/agents/debugger.md`):
```markdown
---
name: debugger
description: Debugging specialist for errors and test failures
tools: glob,grep,read,bash
model: ollama/qwen3.5:4b
---
You are an expert debugger. Find root cause, apply minimal fixes, verify with tests.
```

Call with `task` using `subagent: "debugger"`. Agents can restrict tools, set custom system prompts, models, temperature, and thinking.
