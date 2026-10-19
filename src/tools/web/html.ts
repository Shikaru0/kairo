/**
 * HTML to plain text: drop the invisible chrome, turn block ends into line breaks.
 */

/** Tags whose end marks a line: text inside them is a separate block. */
const BLOCK_END = /<\/(p|div|li|h[1-6]|tr|section|article|header|footer|nav|main|blockquote|pre)\s*>/gi;

/** Strip markup down to what a reader would read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_END, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The same text on one line, for titles and snippets. */
export function htmlToLine(html: string): string {
  return htmlToText(html).replace(/\s+/g, " ");
}
