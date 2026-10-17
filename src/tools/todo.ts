import type { Tool } from "./tool.ts";

export interface Todo {
  text: string;
  status: "pending" | "in_progress" | "done";
}

const MARK = { pending: "[ ]", in_progress: "[~]", done: "[x]" } as const;

/**
 * The current plan. Module scope is enough because every call passes the full
 * list, so the file is only a display cache; subagents share it, and the last
 * writer's plan is the one shown.
 */
let plan: Todo[] = [];

/**
 * Lets the model keep a plan it re-reads: each call replaces the list and
 * returns the rendered result, which lands in history for the next round.
 */
export const todoTool: Tool = {
  name: "todo",
  description:
    "Write or update the plan. Pass the full list to replace it. Call it before multi-step work, " +
    "then after each step to mark progress.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The full plan, in order.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Short description of one step." },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["todos"],
  },
  execute: ({ todos }) => {
    plan = (Array.isArray(todos) ? todos : []).map((item) => {
      const { text, status } = (item ?? {}) as Partial<Todo>;
      return {
        text: String(text ?? ""),
        status: status === "done" || status === "in_progress" ? status : "pending",
      };
    });
    return plan.length ? plan.map((step, i) => `${i + 1}. ${MARK[step.status]} ${step.text}`).join("\n") : "(plan cleared)";
  },
};
