import type { ChatRequest, Message, Provider } from "./provider/provider.ts";

/**
 * Compaction: before the history reaches the window's ceiling, everything
 * after the system prompt is summarised and that summary becomes the new
 * history. Checked before every model round, since a tool-heavy turn can
 * outgrow the window mid-flight. `force` ignores the threshold, for when
 * the window filled anyway.
 */
const COMPACT_AT = 0.65;
/**
 * Rough chars per token, used only to weigh history against the window.
 * Code and JSON run token-dense, so estimating low errs toward compacting
 * early, which is the safe direction.
 */
const CHARS_PER_TOKEN = 3;
/** Fallback for providers that do not report a window. */
const DEFAULT_CONTEXT_SIZE = 32_768;

const NOTES_PREFIX = "[earlier conversation compacted to notes] ";
/** The notes must stay small or compaction buys nothing. */
const NOTES_CAP = 4_000;

/**
 * Prompt for the summariser: ordered most-important-first, and written as
 * what the agent will have to keep working from, since the full text is gone.
 */
const COMPACT_SYSTEM =
  "You compress this conversation into notes that will become the agent's entire memory. " +
  "In this order: the task and current state, where work stopped and what comes next, decisions taken, " +
  "exact file paths and values, then what was tried. Bullet points only, no preamble, " +
  "keep paths and commands verbatim. Be concise.";

/** Emitted by the chat when older turns were replaced, so the REPL can say so. */
export interface Compact {
  type: "compact";
  removed: number;
}

/** What compaction needs from the chat it serves. */
type Context = { provider: Provider } & Pick<ChatRequest, "model" | "temperature" | "thinking">;

/**
 * Compact the history when it fills the provider's window: everything after
 * the system prompt becomes a summary. Returns how many messages were
 * replaced, or 0 when the history is still small or the summariser failed —
 * the caller then keeps the full history, unchanged.
 */
export async function compact(messages: Message[], ctx: Context, force = false): Promise<number> {
  const window = (ctx.provider.contextSize ?? DEFAULT_CONTEXT_SIZE) * CHARS_PER_TOKEN;
  if (!force && JSON.stringify(messages).length < COMPACT_AT * window) return 0;

  const older = messages.slice(1);
  if (older.length === 0) return 0;

  let notes: string;
  try {
    notes = await summarise(older, ctx);
  } catch {
    return 0;
  }

  messages.splice(1, older.length, { role: "assistant", content: NOTES_PREFIX + notes });
  return older.length;
}

/** One tool-free call that compresses the given messages into notes. */
async function summarise(older: Message[], ctx: Context): Promise<string> {
  let out = "";
  for await (const chunk of ctx.provider.stream({
    model: ctx.model,
    temperature: ctx.temperature,
    thinking: ctx.thinking,
    messages: [{ role: "system", content: COMPACT_SYSTEM }, ...older],
  })) {
    if (chunk.type === "text") out += chunk.text;
  }
  return out.trim().slice(0, NOTES_CAP) || "(no summary produced)";
}
