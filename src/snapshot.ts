import { access, readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";

/** Never the shape of a project: dependencies, output, caches, agent state. */
const SKIP = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", "vendor",
  "__pycache__", ".venv", "venv", ".next", ".cache", ".kairo", ".kairo-sessions", ".git",
  ".vscode", ".idea", ".eslintcache", ".DS_Store"
]);

/** Two directory levels orient the model; glob and read cover the rest. */
const MAX_ENTRIES = 12;
/** The block rides in every request, so it is capped like any other prompt part. */
const MAX_CHARS = 2_000;
const MAX_SCRIPT = 80;
/** Named when there is no package.json, so a non-JavaScript project still gets one. */
const MANIFESTS = ["Cargo.toml", "pyproject.toml", "go.mod", "Makefile", "justfile", "deno.json"];

/** One directory as `dir/(files, subdirs/)`, truncated so one level can't own the block. */
async function describe(dir: string, depth: number): Promise<string> {
  let entries;
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => !SKIP.has(entry.name) && !entry.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  } catch {
    return "";
  }
  const parts = await Promise.all(
    entries.slice(0, MAX_ENTRIES).map(async (entry) => {
      if (!entry.isDirectory()) return entry.name;
      const inner = depth > 0 ? await describe(join(dir, entry.name), depth - 1) : "";
      return inner ? `${entry.name}/(${inner})` : `${entry.name}/`;
    }),
  );
  if (entries.length > MAX_ENTRIES) parts.push(`+${entries.length - MAX_ENTRIES} more`);
  return parts.join(", ");
}

/** Branch and uncommitted count, when the directory is the top of a repository. */
function gitState(root: string): string {
  if (!existsSync(join(root, ".git"))) return "";
  try {
    const out = spawnSync("git", ["status", "--short", "--branch"], { cwd: root, encoding: "utf8", timeout: 3_000 });
    if (out.status !== 0 || !out.stdout) return "";
    const [head = "", ...changes] = out.stdout.trimEnd().split("\n");
    const branch = head.replace(/^##\s*/, "").replace(/\.\.\S+$/, "");
    return branch ? `${branch}${changes.length ? ` · ${changes.length} changed` : ""}` : "";
  } catch {
    return "";
  }
}

/** The manifest's scripts, or the name of the build file that is actually there. */
async function commands(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const scripts = Object.entries(pkg.scripts ?? {}).slice(0, 8);
    if (scripts.length) return scripts.map(([name, value]) => `${name}: ${value.slice(0, MAX_SCRIPT)}`).join(" · ");
  } catch {
    /* no or unreadable package.json */
  }
  for (const name of MANIFESTS) {
    try {
      await access(join(root, name));
      return name;
    } catch {
      /* not this one */
    }
  }
  return "";
}

/**
 * What a model needs to start oriented: the project's shape, its git state, and
 * how it builds and runs. Computed once at startup and put in the system prompt,
 * so a local provider pays for it in one cached prefix instead of every request.
 * It is a snapshot, not the truth: files change after it is taken.
 */
export async function projectSnapshot(root = process.cwd()): Promise<string> {
  const [tree, build] = await Promise.all([describe(root, 1), commands(root)]);
  const state = gitState(root);
  const lines = [`[project snapshot] ${basename(root)}${state ? ` · ${state}` : ""}`];
  if (tree) lines.push(`tree: ${tree}`);
  if (build) lines.push(`scripts: ${build}`);
  if (!tree && !build) return "";
  const text = lines.join("\n");
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n[snapshot truncated]`;
}
