import type { Tool } from "../tool.ts";
import { htmlToLine } from "./html.ts";
import { randomUserAgent } from "./user-agents.ts";

/** How long a search may take before it gives up. */
const TIMEOUT_MS = 30_000;
/** Results returned when the model does not say how many it wants. */
const DEFAULT_LIMIT = 8;

/** Exa's search MCP. Answers without a key; EXA_API_KEY raises its limits. */
const MCP_URL = "https://mcp.exa.ai/mcp";

/**
 * Web search with a choice of backend: Exa's search MCP by default, falling
 * back to DuckDuckGo's HTML endpoint when the MCP fails or comes back empty.
 * KAIRO_SEARCH=ddg forces the scraped one — but DuckDuckGo serves bot-checks
 * under load, so it is the fallback, not the default.
 */
export const webSearchTool: Tool = {
  name: "websearch",
  description:
    "Search the web and return each result's title, URL and snippet. " +
    "Use when: you need current facts, documentation, or a page you do not have the URL for - " +
    "websearch first, then webfetch the results worth reading. For file contents or symbols use grep/read.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      limit: { type: "number", description: "Maximum results to return. Defaults to 8." },
    },
    required: ["query"],
  },
  execute: async ({ query, limit }) => {
    const q = String(query ?? "").trim();
    if (!q) return "Error: pass a query to search for.";
    const n = Math.max(1, Number(limit) || DEFAULT_LIMIT);
    if (process.env.KAIRO_SEARCH !== "ddg") {
      // A slow or unreachable MCP must not kill the search: fall through to DuckDuckGo.
      const viaMcp = await exa(q, n).catch(() => undefined);
      if (viaMcp) return viaMcp;
    }
    return duckduckgo(q, n);
  },
};

/** DuckDuckGo's HTML endpoint: a plain form POST whose results are scraped out. */
async function duckduckgo(query: string, limit: number): Promise<string> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": randomUserAgent(),
    },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return `Error: search returned ${response.status} ${response.statusText}`;
  return parseResults(await response.text(), query, limit);
}

/** Exa's search MCP over JSON-RPC; the reply carries ready-made text for the model. */
async function exa(query: string, limit: number): Promise<string | undefined> {
  const url = new URL(MCP_URL);
  if (process.env.EXA_API_KEY) url.searchParams.set("exaApiKey", process.env.EXA_API_KEY);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": randomUserAgent(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, type: "auto", numResults: limit, livecrawl: "fallback" },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  return mcpText(await response.text());
}

const RESULT_LINK = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const RESULT_SNIPPET = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

/** Numbered title/URL/snippet lines from a DuckDuckGo results page; exported for the test. */
export function parseResults(html: string, query: string, limit: number): string {
  const links = [...html.matchAll(RESULT_LINK)];
  const snippets = [...html.matchAll(RESULT_SNIPPET)];
  const results = links.slice(0, limit).map(([, href = "", title = ""], i) => {
    const url = resolveUrl(href);
    const snippet = snippets[i]?.[1];
    return `${htmlToLine(title)}\n  ${url}${snippet ? `\n  ${htmlToLine(snippet)}` : ""}`;
  });
  if (!results.length) {
    // A bot-check page has no results either; the model must not read that as "nothing exists".
    return html.includes("anomaly")
      ? "Error: the search engine served a bot-check page instead of results; try again later"
      : `no results for "${query}"`;
  }
  return `results for "${query}":\n\n${results.map((r, i) => `${i + 1}. ${r}`).join("\n\n")}`;
}

/** DDG wraps some links in a /l/?uddg= redirect; unwrap it to the real URL. */
function resolveUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? url.href;
  } catch {
    return href;
  }
}

/** The answer text of an MCP reply, sent either as bare JSON or as SSE `data:` lines; exported for the test. */
export function mcpText(body: string): string | undefined {
  const trimmed = body.trim();
  const payload = trimmed.startsWith("{")
    ? trimmed
    : body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as { result?: { content?: Array<{ text?: string }> } };
    return parsed.result?.content?.find((item) => item.text)?.text;
  } catch {
    return undefined;
  }
}
