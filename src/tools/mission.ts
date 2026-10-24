import { createChat } from "../chat.ts";
import type { Agent } from "./task.ts";
import type { Tool } from "./tool.ts";
import type { SubagentDef } from "../agents/agent.ts";

const SUBAGENT_SYSTEM =
  "You are a subagent with exactly one task, and nothing can answer a question back: " +
  "make reasonable assumptions and state them instead of asking. " +
  "Search code with grep and glob, read files with read, and keep bash for commands, builds and tests rather than for making changes. " +
  "Before editing a file, read it first and copy oldString exactly from that read; never edit from memory. " +
  "Never rewrite or weaken a test to make it pass; if a test looks wrong, say so and leave it alone. " +
  "Run a check on any change before you call it done, and never create files nobody asked for. " +
  "Work the task with the tools, then answer with only what the caller needs: " +
  "exact paths, values and conclusions, no preamble.";

export type MissionTaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped";

export interface MissionTask {
  id: string;
  title: string;
  description: string;
  deps?: string[];
  subagent?: string;
  model?: string;
  status: MissionTaskStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Mission {
  id: string;
  goal: string;
  tasks: MissionTask[];
  status: "planning" | "running" | "paused" | "done" | "failed";
  createdAt: number;
  updatedAt: number;
}

const missions = new Map<string, Mission>();
let nextMissionId = 0;
let nextTaskId = 0;

function genMissionId(): string {
  return `m${nextMissionId++}`;
}

function genTaskId(): string {
  return `t${nextTaskId++}`;
}

function now(): number {
  return Date.now();
}

function computeReady(mission: Mission): void {
  const done = new Set<string>();
  const failed = new Set<string>();
  for (const t of mission.tasks) {
    if (t.status === "done") done.add(t.id);
    if (t.status === "failed") failed.add(t.id);
  }
  for (const t of mission.tasks) {
    if (t.status !== "pending") continue;
    const deps = t.deps ?? [];
    let ok = true;
    for (const d of deps) {
      if (failed.has(d)) {
        t.status = "skipped";
        t.error = `skipped due to failed dependency ${d}`;
        ok = false;
        break;
      }
      if (!done.has(d)) {
        ok = false;
        break;
      }
    }
    if (ok && deps.length >= 0) {
      // ready if all deps satisfied (or no deps)
      const allDepsDone = deps.every((d) => done.has(d));
      if (allDepsDone) t.status = "ready";
    }
  }
}

function missionSummary(m: Mission): string {
  const counts: any = { pending: 0, ready: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const t of m.tasks) counts[t.status]++;
  const lines: string[] = [];
  lines.push(`Mission ${m.id}: ${m.goal}`);
  lines.push(`Status: ${m.status} | tasks: ${m.tasks.length} (pending:${counts.pending} ready:${counts.ready} running:${counts.running} done:${counts.done} failed:${counts.failed} skipped:${counts.skipped})`);
  lines.push("");
  for (const t of m.tasks) {
    const deps = t.deps?.length ? ` deps:[${t.deps.join(",")}]` : "";
    const ag = t.subagent ? ` @${t.subagent}` : "";
    lines.push(`  [${t.status}] ${t.id}: ${t.title}${deps}${ag}`);
    if (t.status === "done" && t.result) {
      const preview = t.result.length > 120 ? t.result.slice(0, 117) + "..." : t.result;
      lines.push(`      -> ${preview.replace(/\n/g, " ")}`);
    }
    if (t.status === "failed" && t.error) {
      lines.push(`      !! ${t.error}`);
    }
    if (t.status === "skipped" && t.error) {
      lines.push(`      -- ${t.error}`);
    }
  }
  return lines.join("\n");
}

export function missionTool(agent: Agent, spawn: (model: string, allowedTools?: string[]) => Tool[]): Tool {
  const subagents = agent.subagents ?? [];

  function getToolsFor(def?: SubagentDef, model?: string) {
    const all = spawn(model ?? agent.model, def?.tools);
    if (!def?.tools?.length) return all;
    return all.filter((t) => def.tools!.includes(t.name) || t.name === "task" || t.name === "bg" || t.name === "mission");
  }

  async function startTask(mission: Mission, task: MissionTask) {
    const def = task.subagent ? (subagents as SubagentDef[]).find((a: SubagentDef) => a.name === task.subagent) : undefined;
    if (task.subagent && !def && task.subagent !== "general-purpose") {
      // allow built-ins by name even if not in custom list
    }
    const chosenModel = task.model ?? def?.model ?? agent.model;
    const system = def?.system ?? SUBAGENT_SYSTEM;
    const temp = def?.temperature ?? agent.temperature;
    const think = def?.thinking ?? agent.thinking;

    const child = createChat(agent.provider, {
      model: chosenModel,
      temperature: temp,
      thinking: think,
      system,
      tools: getToolsFor(def, chosenModel),
      verify: false,
    });

    task.status = "running";
    task.startedAt = now();
    mission.status = "running";
    mission.updatedAt = now();

    const prompt = [
      `Mission: ${mission.goal}`,
      `Task: ${task.title}`,
      "",
      task.description,
      "",
      "Complete this task. Return only what is needed: concrete results, file paths, changes made, and key findings. No preamble.",
    ].join("\n");

    let answer = "";
    try {
      for await (const chunk of child.send(prompt)) {
        if (chunk.type === "text") answer += chunk.text;
        if (chunk.type === "stop" && chunk.reason === "stuck") {
          answer += "\n(subagent stopped: its tool calls kept failing)";
        }
      }
      task.result = answer.trim() || "(task returned nothing)";
      task.status = "done";
      task.finishedAt = now();
    } catch (err) {
      task.error = err instanceof Error ? err.message : String(err);
      task.status = "failed";
      task.finishedAt = now();
    }
    mission.updatedAt = now();
    computeReady(mission);
    // check if all done
    const allDone = mission.tasks.every((t) => t.status === "done" || t.status === "skipped");
    const anyFailed = mission.tasks.some((t) => t.status === "failed");
    if (allDone && !anyFailed) mission.status = "done";
    else if (anyFailed && mission.tasks.every((t) => t.status !== "running" && t.status !== "ready")) {
      mission.status = "failed";
    }
  }

  const agentList = subagents.length
    ? subagents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
    : "- general-purpose, explore, plan (built-ins)";

  return {
    name: "mission",
    description:
      "Autonomous task decomposition with dependency tracking. Break a goal into a DAG of tasks and run independent tasks in parallel via subagents. " +
      "Actions: create (define tasks with deps), run (start ready tasks), status (view progress), list (all missions), clear (remove mission). " +
      "Available subagents:\n" + agentList,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "run", "status", "list", "clear"],
          description: "Action to perform.",
        },
        missionId: { type: "string", description: "Mission ID (for status/run/clear)." },
        goal: { type: "string", description: "Goal to accomplish (for create)." },
        tasks: {
          type: "array",
          description: "Tasks with deps (for create). Each needs id, title, description; optional deps[], subagent, model.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              deps: { type: "array", items: { type: "string" } },
              subagent: { type: "string" },
              model: { type: "string" },
            },
            required: ["id", "title", "description"],
          },
        },
        parallel: { type: "boolean", description: "Run ready tasks in parallel (default true for run)." },
      },
      required: ["action"],
    },
    execute: async ({ action, missionId, goal, tasks, parallel }) => {
      const act = String(action);

      if (act === "list") {
        if (missions.size === 0) return "No missions.";
        const out: string[] = [];
        for (const m of missions.values()) {
          const c: any = { pending: 0, ready: 0, running: 0, done: 0, failed: 0, skipped: 0 };
          for (const t of m.tasks) c[t.status]++;
          out.push(`${m.id}: [${m.status}] ${m.goal} (${m.tasks.length} tasks, done:${c.done} failed:${c.failed})`);
        }
        return out.join("\n");
      }

      if (act === "create") {
        if (!goal) return "Error: goal required for create";
        if (!Array.isArray(tasks) || tasks.length === 0) return "Error: tasks array required for create";
        const m: Mission = {
          id: genMissionId(),
          goal: String(goal),
          tasks: (tasks as any[]).map((t) => ({
            id: String(t.id || genTaskId()),
            title: String(t.title || ""),
            description: String(t.description || ""),
            deps: Array.isArray(t.deps) ? t.deps.map(String) : [],
            subagent: t.subagent ? String(t.subagent) : undefined,
            model: t.model ? String(t.model) : undefined,
            status: "pending" as MissionTaskStatus,
          })),
          status: "planning",
          createdAt: now(),
          updatedAt: now(),
        };
        // validate deps exist
        const ids = new Set(m.tasks.map((t) => t.id));
        for (const t of m.tasks) {
          for (const d of t.deps ?? []) {
            if (!ids.has(d)) return `Error: task ${t.id} depends on unknown task ${d}`;
          }
        }
        computeReady(m);
        if (m.tasks.some((t) => t.status === "ready")) m.status = "running";
        missions.set(m.id, m);
        return `Created mission ${m.id}\n\n${missionSummary(m)}`;
      }

      if (act === "status") {
        const mid = String(missionId ?? "");
        const m = missions.get(mid);
        if (!m) return `Error: mission ${mid} not found`;
        computeReady(m);
        return missionSummary(m);
      }

      if (act === "clear") {
        const mid = String(missionId ?? "");
        if (missions.delete(mid)) return `Cleared mission ${mid}`;
        return `Mission ${mid} not found`;
      }

      if (act === "run") {
        const mid = String(missionId ?? "");
        const m = missions.get(mid);
        if (!m) return `Error: mission ${mid} not found`;
        computeReady(m);
        const ready = m.tasks.filter((t) => t.status === "ready");
        if (ready.length === 0) {
          const allDone = m.tasks.every((t) => t.status === "done" || t.status === "skipped");
          const anyFailed = m.tasks.some((t) => t.status === "failed");
          if (allDone && !anyFailed) m.status = "done";
          else if (anyFailed) m.status = "failed";
          m.updatedAt = now();
          return `No ready tasks.\n\n${missionSummary(m)}`;
        }
        const doParallel = parallel !== false;
        if (doParallel) {
          await Promise.all(ready.map((t) => startTask(m, t)));
        } else {
          for (const t of ready) await startTask(m, t);
        }
        computeReady(m);
        const allDone = m.tasks.every((t) => t.status === "done" || t.status === "skipped");
        const anyFailed = m.tasks.some((t) => t.status === "failed");
        if (allDone && !anyFailed) m.status = "done";
        else if (anyFailed && m.tasks.every((t) => t.status !== "running" && t.status !== "ready")) {
          m.status = "failed";
        } else if (m.tasks.some((t) => t.status === "running")) {
          m.status = "running";
        }
        m.updatedAt = now();
        return `Ran ${ready.length} task(s) in ${doParallel ? "parallel" : "series"}.\n\n${missionSummary(m)}`;
      }

      return "Error: unknown action. Use create/run/status/list/clear";
    },
  };
}
