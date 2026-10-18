/**
 * Provider abstraction. A completion is requested with a model, a message
 * history and the tools the model may call, and consumed as a stream of chunks.
 * Vendors (Ollama, OpenAI, ...) implement `Provider`
 */

/** What the model is told about a callable capability. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

/** A tool call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model. */
  arguments: string;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  /** `toolCalls` is set when the assistant asked for tools instead of answering. */
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; reasoning?: string }
  /** `toolCallId` names the call this result answers. */
  | { role: "tool"; content: string; toolCallId: string };

/** How much the model may think before answering; `false` disables reasoning. */
export type Thinking = boolean | "low" | "medium" | "high";

export interface ChatRequest {
  /** Model name as the provider understands it, e.g. "qwen3:4b". */
  model: string;
  messages: Message[];
  /** Tools the model can run. */
  tools?: ToolSpec[];
  /** Sampling temperature; the model's default when omitted. */
  temperature?: number;
  /** Reasoning effort; `true` asks for the model's middle level. */
  thinking?: Thinking;
}

/** One streamed piece of a completion, tagged so callers can render it apart. */
export type Chunk =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "toolCall"; call: ToolCall }
  /** Last chunk of a turn; `reason` is the vendor's finish reason ("stop", "length", ...). */
  | { type: "finish"; reason: string };

export interface Provider {
  /** Identifier of this provider, e.g. "ollama". */
  readonly id: string;
  /**
   * Context window in tokens the provider will actually serve, so callers can
   * size their work against it. Absent when the limit is unknown.
   */
  readonly contextSize?: number;
  /** Stream a completion, yielding chunks in the order the model produced them. */
  stream(request: ChatRequest): AsyncIterable<Chunk>;
}
