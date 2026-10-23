import type { ChatRequest, Chunk, Message, Provider, ToolSpec } from "./provider.ts";

export interface OllamaOptions {
  /** Name the provider reports; defaults to "ollama". */
  id?: string;
  /** Context window in tokens. */
  contextSize?: number;
}

/**
 * Ollama's own default is small enough that a tool loop gets silently truncated
 * (it drops the front of the prompt, system message included), so ask for more.
 * Every round re-sends the whole history, so a tool-heavy turn eats this fast.
 */
const DEFAULT_CONTEXT_SIZE = 65_536;

/** Transient failures get this many retries, on a fixed delay, per request. */
export const RETRIES = 5;
const RETRY_DELAY_MS = 2_000;

/** One NDJSON line of `/api/chat`'s stream. */
interface OllamaChunk {
  error?: string;
  done?: boolean;
  done_reason?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Native Ollama accepts reasoning back, so the model can build on its own thinking. */
  thinking?: string;
  tool_name?: string;
  tool_calls?: Array<{ type: "function"; function: { name: string; arguments: Record<string, unknown> } }>;
}

/**
 * Ollama's native API. Not the OpenAI-compatible `/v1`: that one ignores
 * `num_ctx`, so the context window can't be raised from the request.
 */
export function ollama(
  host = "http://127.0.0.1:11434",
  { id = "ollama", contextSize = DEFAULT_CONTEXT_SIZE }: OllamaOptions = {},
): Provider {
  const url = new URL("/api/chat", host).href;

  return {
    id,
    contextSize,
    async *stream({ model, messages, tools, temperature, thinking }: ChatRequest) {
      const names = toolNames(messages);
      const response = await request(
        url,
        JSON.stringify({
          model,
          messages: messages.map((message) => toOllamaMessage(message, names)),
          tools: tools?.length ? tools.map(toWireTool) : undefined,
          think: thinking,
          stream: true,
          options: { num_ctx: contextSize, temperature },
        }),
      );
      if (!response.body) throw new Error("ollama: empty response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finish: string | undefined;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;

          const part = JSON.parse(line) as OllamaChunk;
          if (part.error) throw new Error(`ollama: ${part.error}`);
          const message = part.message ?? {};
          if (message.thinking) yield { type: "reasoning", text: message.thinking };
          if (message.content) yield { type: "text", text: message.content };

          const calls = message.tool_calls ?? [];
          for (const [index, call] of calls.entries()) {
            // Ollama hands out no call ids, so mint one that stays unique across
            // rounds and reloads by counting the history it was requested with.
            yield {
              type: "toolCall",
              call: {
                id: `call_${messages.length}_${index}`,
                name: call.function?.name ?? "",
                arguments: JSON.stringify(call.function?.arguments ?? {}),
              },
            };
          }
          if (part.done) finish = part.done_reason ?? "stop";
        }
      }

      if (finish) yield { type: "finish", reason: finish };
    },
  };
}

/** A hiccup worth retrying: rate limited, or the server fell over. */
const retryable = (status: number) => status === 429 || status >= 500;

const sleep = () => new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

/**
 * One request. Transient failures — a dropped connection, or an ollama runner
 * that died and relaunches (429, 5xx) — retry on a fixed delay; the budget is
 * per request, so every call starts fresh. Anything else fails immediately,
 * carrying the server's own error text, and running out of retries does too.
 */
async function request(url: string, payload: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    } catch (error) {
      if (attempt === RETRIES) throw error;
      await sleep();
      continue;
    }
    if (response.ok) return response;
    const detail = await response.text();
    if (retryable(response.status) && attempt < RETRIES) {
      await sleep();
      continue;
    }
    throw new Error(`ollama ${response.status}: ${detail}`);
  }
}

/** Ollama takes tool schemas in the OpenAI wrapper shape, not as bare specs. */
function toWireTool({ name, description, parameters }: ToolSpec) {
  return { type: "function" as const, function: { name, description, parameters } };
}

/**
 * Tool results are keyed by name in Ollama, so recover the id-to-name map from history.
 */
function toolNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    }
  }
  return names;
}

function toOllamaMessage(message: Message, names: Map<string, string>): OllamaMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", content: message.content, tool_name: names.get(message.toolCallId) ?? "" };
    case "assistant": {
      const base = { role: "assistant" as const, content: message.content, thinking: message.reasoning };
      return message.toolCalls?.length
        ? {
            ...base,
            tool_calls: message.toolCalls.map((call) => ({
              type: "function" as const,
              function: { name: call.name, arguments: parseArguments(call.arguments) },
            })),
          }
        : base;
    }
  }
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}
