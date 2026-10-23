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

/** Emitted when older tool results were elided instead, the cheaper of the two. */
export interface Trim {
  type: "trim";
  elided: number;
}

/**
 * Small compaction runs first, at a lower watermark than the summariser: older
 * tool results keep only their head. A dump that has already been read does not
 * need re-sending in full every round, and the recent messages — the ones the
 * model is actually working from — stay verbatim.
 */
const TRIM_AT = 0.4;
/** Messages at the end of the history that trimming never touches. */
const TRIM_KEEP_TAIL = 6;
/** How much of each older tool result survives. */
const TRIM_KEEP_CHARS = 500;

/** What compaction needs from the chat it serves. */
type Context = { provider: Provider } & Pick<ChatRequest, "model" | "temperature">;

/**
 * Rough share of the provider's window still free, 0..1, by the same estimate
 * compaction weighs. Kept in one place so a nudge and a compaction agree on
 * how full the window is.
 */
export function freeSpace(messages: Message[], provider: Provider): number {
  const window = (provider.contextSize ?? DEFAULT_CONTEXT_SIZE) * CHARS_PER_TOKEN;
  return Math.max(0, 1 - JSON.stringify(messages).length / window);
}

/**
 * Elide the middle of older tool results, newest messages left alone. Returns
 * how many results were elided, or 0 when the window still has room or there is
 * nothing long enough to be worth trimming. It runs before the summariser
 * rather than instead of it: a stale result loses its middle, not the whole
 * conversation. Rewriting old history also ends the provider's cached prefix at
 * that message, so the cache stays warm while there is room and is re-read once
 * when trim fires; that is still far cheaper than the model call compaction
 * would make.
 */
export function trim(messages: Message[], provider: Provider): number {
  if (freeSpace(messages, provider) > 1 - TRIM_AT) return 0;

  let elided = 0;
  const last = Math.max(1, messages.length - TRIM_KEEP_TAIL);
  for (let i = 1; i < last; i++) {
    const message = messages[i];
    if (message?.role !== "tool" || message.content.length <= TRIM_KEEP_CHARS) continue;
    messages[i] = {
      role: "tool",
      toolCallId: message.toolCallId,
      content: `${message.content.slice(0, TRIM_KEEP_CHARS)}\n[trimmed ${message.content.length} chars from this result]`,
    };
    elided++;
  }
  return elided;
}

/**
 * Compact the history when it fills the provider's window: everything after
 * the system prompt becomes a summary. Returns how many messages were
 * replaced, or 0 when the history is still small or the summariser failed —
 * the caller then keeps the full history, unchanged.
 */
export async function compact(messages: Message[], ctx: Context, force = false): Promise<number> {
  if (!force && freeSpace(messages, ctx.provider) > 1 - COMPACT_AT) return 0;

  const older = messages.slice(1);
  if (older.length === 0) return 0;

  let notes: string;
  try {
    notes = await summarise(older, ctx);
  } catch {
    return 0;
  }
  // A summariser that produced nothing must not replace the history: keeping
  // the full conversation beats compaction to a placeholder.
  if (!notes) return 0;

  messages.splice(1, older.length, { role: "assistant", content: NOTES_PREFIX + notes });
  return older.length;
}

/** One tool-free call that compresses the given messages into notes. */
async function summarise(older: Message[], ctx: Context): Promise<string> {
  let out = "";
  for await (const chunk of ctx.provider.stream({
    model: ctx.model,
    temperature: ctx.temperature,
    // Reasoning off on purpose: with it on, this model can spend the whole
    // generation thinking and return empty content — which would otherwise
    // replace the history with nothing.
    thinking: false,
    messages: [{ role: "system", content: COMPACT_SYSTEM }, ...older],
  })) {
    if (chunk.type === "text") out += chunk.text;
  }
  return out.trim().slice(0, NOTES_CAP);
}
