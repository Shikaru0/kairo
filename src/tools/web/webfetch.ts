import type { Tool } from "../tool.ts";
import { htmlToText } from "./html.ts";
import { randomUserAgent } from "./user-agents.ts";

/** How long a page may take before the fetch gives up. */
const TIMEOUT_MS = 15_000;

/**
 * Fetch a URL: readable text with the markup stripped by default, or the raw
 * HTML when asked. Failures surface to the model as an error result.
 */
export const webFetchTool: Tool = {
  name: "webfetch",
  description:
    "Fetch a URL over HTTP and return its contents as readable text; set html to get the raw HTML instead. " +
    "Use when: a websearch result or a known link points at the page you need - " +
    "fetch it and read what is there; plain text files and raw sources download as-is. " +
    "For local files use read instead.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to fetch." },
      html: { type: "boolean", description: "Return the raw HTML instead of text with the tags stripped." },
    },
    required: ["url"],
  },
  execute: async ({ url, html }) => {
    const response = await fetch(String(url), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "user-agent": randomUserAgent(),
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) return `Error: ${response.status} ${response.statusText} for ${url}`;
    const body = await response.text();
    // Anything that is not HTML is already text (plain files, JSON, source): only a page needs stripping.
    const isHtml = (response.headers.get("content-type") ?? "").includes("text/html");
    return html === true || html === "true" || !isHtml ? body : htmlToText(body);
  },
};
