/**
 * Text serialization boundaries for report exports (R6-2, R6-3: Consensus Integrity)
 *
 * Model-written text (claims, explanations, bias observations, per-model
 * positions) is untrusted content: inside a Markdown or plain-text document
 * it must stay content and never become document structure. This module is
 * the one place the text formats apply that rule:
 *
 *   escapeMarkdownInline   one line of Markdown text — every Markdown/HTML
 *                          construct is escaped and line breaks become spaces
 *   markdownQuote          a block of model prose as a Markdown blockquote —
 *                          every line quoted and escaped, so a model's
 *                          "## Conclusion" is a literal line inside the quote,
 *                          under its label, never a report heading
 *   plainTextQuote         the same block for plain text (memo) — every line
 *                          prefixed, so the block stays visibly one quoted unit
 *
 * Escaping is applied once, here, at serialization. Stored text, claim
 * identity and the HTML / DOCX / PDF renderers (which escape for their own
 * format) are untouched. Application-generated headings and computed text are
 * written by the builders and never pass through these functions.
 * Pure and client-safe.
 */

/** CommonMark/GFM characters that can start inline structure or HTML anywhere in a line ("@": GFM email autolinks). */
const INLINE_SPECIAL = /([\\`*_[\]#<>|~&@])/g;

/** GFM autolink literals ("http://…", "www.…"): the URL stays visible as text but is not made a link. */
const AUTOLINK_LITERAL = /(\b[A-Za-z][A-Za-z0-9+.-]*):(?=\/\/)|\b(www)\.(?=\S)/gi;

/** Line-start block markers left after INLINE_SPECIAL: list bullets, setext underlines / thematic breaks, ordered-list numbers. */
const LINE_START_MARKER = /^([ \t]*)(?:([-+=])|(\d{1,9})([.)]))/;

function escapeMarkdownLine(line: string): string {
  return line
    .replace(INLINE_SPECIAL, "\\$1")
    .replace(AUTOLINK_LITERAL, (_m, scheme?: string, www?: string) => (scheme ? `${scheme}\\:` : `${www}\\.`))
    .replace(LINE_START_MARKER, (_m, lead: string, bullet?: string, num?: string, delim?: string) =>
      bullet ? `${lead}\\${bullet}` : `${lead}${num}\\${delim}`
    );
}

/** Model-written text placed inside one Markdown line: escaped, line breaks collapsed to a space. */
export function escapeMarkdownInline(text: string): string {
  return escapeMarkdownLine(text.replace(/[ \t]*\r?\n[ \t]*/g, " "));
}

const lines = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

/**
 * Model-written prose as a Markdown blockquote: every line quoted and escaped; blank lines stay inside the quote
 * (paragraphs), and a line followed by another line ends in a hard break so the model's line breaks are kept.
 */
export function markdownQuote(text: string, indent = ""): string[] {
  const all = lines(text);
  return all.map((line, i) => {
    if (!line.trim()) return `${indent}>`;
    const next = all[i + 1];
    return `${indent}> ${escapeMarkdownLine(line)}${next !== undefined && next.trim() ? "\\" : ""}`;
  });
}

/** Model-written prose for plain text: every line prefixed with "> " so the block stays one quoted unit. */
export function plainTextQuote(text: string, indent = ""): string[] {
  return lines(text).map((line) => (line.trim() ? `${indent}> ${line}` : `${indent}>`));
}
