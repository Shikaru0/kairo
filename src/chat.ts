import type { ChatRequest, Chunk, Message, Provider } from "./provider/provider.ts";

const DEFAULT_SYSTEM = "You are a helpful assistant.";

/** Anything that configures one conversation; everything but the history. */
export interface ChatOptions extends Omit<ChatRequest, "messages"> {
  system?: string;
}

/**
 * A conversation with a provider: keeps the message history and appends each
 * exchange, so every turn sees what came before.
 */
export function createChat(provider: Provider, { model, temperature, thinking, system = DEFAULT_SYSTEM }: ChatOptions) {
  const messages: Message[] = [{ role: "system", content: system }];

  return {
    async *send(input: string): AsyncIterable<Chunk> {
      messages.push({ role: "user", content: input });
      let reply = "";
      try {
        for await (const chunk of provider.stream({ model, temperature, thinking, messages })) {
          if (chunk.type === "text") reply += chunk.text;
          yield chunk;
        }
      } finally {
        // Runs even if the caller stops mid-stream, so history stays consistent.
        messages.push({ role: "assistant", content: reply });
      }
    },
  };
}
