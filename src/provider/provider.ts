/**
 * Provider abstraction. A completion is requested with a model and a
 * message history, and consumed as a stream of chunks. 
 * Vendors (Ollama, OpenAI, ...) implement `Provider`
 */

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

/** How much the model may think before answering; `false` disables reasoning. */
export type Thinking = boolean | "low" | "medium" | "high";

export interface ChatRequest {
  /** Model name as the provider understands it, e.g. "qwen3:4b". */
  model: string;
  messages: Message[];
  /** Sampling temperature; the model's default when omitted. */
  temperature?: number;
  /** Reasoning effort; `true` asks for the model's middle level. */
  thinking?: Thinking;
}

/** One streamed piece of a completion, tagged so callers can render it apart. */
export interface Chunk {
  type: "reasoning" | "text";
  text: string;
}

export interface Provider {
  /** Identifier of this provider, e.g. "ollama". */
  readonly id: string;
  /** Stream a completion, yielding chunks in the order the model produced them. */
  stream(request: ChatRequest): AsyncIterable<Chunk>;
}
