import OpenAI from "openai";
import type { ChatRequest, Provider, Thinking } from "./provider.ts";

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
    async *stream({ model, messages, temperature, thinking }: ChatRequest) {
      const completion = await client.chat.completions.create({
        model,
        messages,
        temperature,
        reasoning_effort: effort(thinking),
        stream: true,
      });
      for await (const chunk of completion) {
        const delta = chunk.choices[0]?.delta as Delta | undefined;
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoning) yield { type: "reasoning", text: reasoning };
        if (delta?.content) yield { type: "text", text: delta.content };
      }
    },
  };
}

/**
 * OpenAI only types `content`; thinking travels in an extension field.
 * Ollama uses `reasoning`, DeepSeek/vLLM/LM Studio use `reasoning_content`.
 */
interface Delta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
}

/** Map the neutral knob onto OpenAI's `reasoning_effort` vocabulary. */
function effort(thinking: Thinking | undefined) {
  if (thinking === false) return "none";
  if (thinking === true) return "medium";
  return thinking;
}
