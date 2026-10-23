import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatRequest, Message, Provider, Thinking, ToolCall, ToolSpec } from "./provider.ts";

export interface OpenAICompatibleOptions {
  /** Identifier exposed by the resulting provider, e.g. "ollama". */
  id: string;
  /** API root including the version segment, e.g. "http://127.0.0.1:11434/v1". */
  baseURL: string;
  /** Sent as a bearer token; required by most hosts, ignored by Ollama. */
  apiKey?: string;
}

/**
 * Provider for any host speaking the OpenAI `/chat/completions` protocol:
 * OpenAI itself, Ollama, vLLM, LM Studio, Groq, OpenRouter, ...
 */
export function openaiCompatible({ id, baseURL, apiKey }: OpenAICompatibleOptions): Provider {
  const client = new OpenAI({ baseURL, apiKey });
  return {
    id,
    async *stream({ model, messages, tools, temperature, thinking }: ChatRequest) {
      const completion = await client.chat.completions.create({
        model,
        messages: messages.map(toWireMessage),
        tools: tools?.length ? tools.map(toWireTool) : undefined,
        temperature,
        reasoning_effort: effort(thinking),
        stream: true,
      });

      // Tool call arguments stream in fragments keyed by index, so reassemble
      // them and only hand out a call once the stream is done.
      const calls = new Map<number, ToolCall>();
      let finish: string | undefined;
      for await (const chunk of completion) {
        const choice = chunk.choices[0];
        const delta = choice?.delta as Delta | undefined;
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoning) yield { type: "reasoning", text: reasoning };
        if (delta?.content) yield { type: "text", text: delta.content };
        if (choice?.finish_reason) finish = choice.finish_reason;

        for (const partial of delta?.tool_calls ?? []) {
          const call = calls.get(partial.index) ?? { id: "", name: "", arguments: "" };
          if (partial.id) call.id = partial.id;
          call.name += partial.function?.name ?? "";
          call.arguments += partial.function?.arguments ?? "";
          calls.set(partial.index, call);
        }
      }
      for (const call of calls.values()) yield { type: "toolCall", call };
      if (finish) yield { type: "finish", reason: finish };
    },
  };
}

function toWireMessage(message: Message): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
    case "assistant": {
      // Chat Completions drops reasoning on every request, so replay it inside
      // the content — otherwise each tool round starts with the model blind to
      // its own earlier thinking.
      const content = message.reasoning
        ? `<thinking>\n${message.reasoning}\n</thinking>\n${message.content}`
        : message.content;
      return message.toolCalls?.length
        ? { role: "assistant", content, tool_calls: message.toolCalls.map(toWireCall) }
        : { role: "assistant", content };
    }
  }
}

function toWireCall({ id, name, arguments: args }: ToolCall) {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

function toWireTool({ name, description, parameters }: ToolSpec): ChatCompletionTool {
  return { type: "function", function: { name, description, parameters } };
}

/**
 * OpenAI only types `content`; thinking travels in an extension field.
 * Ollama uses `reasoning`, DeepSeek/vLLM/LM Studio use `reasoning_content`.
 */
interface Delta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * Map the neutral knob onto OpenAI's `reasoning_effort` vocabulary. `false`
 * sends nothing at all: hosts that predate reasoning reject the field outright,
 * so "off" has to mean "absent", not some vendor's spelling of none.
 */
function effort(thinking: Thinking | undefined) {
  if (thinking === false) return undefined;
  if (thinking === true) return "medium";
  return thinking;
}
