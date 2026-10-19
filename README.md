# kairo

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

## Plugins

Kairo loads [Agent Plugins](https://agent-plugins.org) 1.0.0 packages at startup, from:

1. `./.kairo/plugins/<plugin>/` - project plugins, which shadow a user plugin of the same name
2. `~/.config/kairo/plugins/<plugin>/`
3. every directory in `KAIRO_PLUGINS` (colon-separated)

A package is a directory with a `plugin.json`. Its `skills/<name>/SKILL.md` files are catalogued in the system prompt and loaded on demand through the `skill` tool, and the servers in its `mcp.json` (`stdio` and `streamable-http`) become `server_tool` tools, named the way OpenCode names MCP tools. A server's handshake `instructions` go into the system prompt as well, and so does the package's own `AGENTS.md`, if it has one: standing instructions that belong in every session. A broken package, skill or server is reported and skipped rather than failing the session; `/plugins` lists what loaded and everything that was skipped. Notes are also printed at startup.

Outside any package, Kairo reads `~/.config/kairo/AGENTS.md` and `./AGENTS.md` the same way — the standing-instructions file Claude Code, Codex and OpenCode share. Both are optional; the user's text comes first, then the project's, then the plugins'. Each is capped at 32 KB (a prompt is re-sent every round) and an unreadable or oversized one is reported and ignored. Only the working directory is checked, not its parents.

Loose skills — skills not inside a package — are picked up from the same directories OpenCode and Claude Code read, project first: `.kairo/skill`, `.kairo/skills`, `.agents/skills`, `.claude/skills`, then the user-level `~/.config/kairo/{skill,skills}`, `~/.agents/skills` and `~/.claude/skills`. A name collision keeps the first found and reports the shadowed one.
