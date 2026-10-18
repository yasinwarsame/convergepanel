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
 *   splitLines / joinLines the one line-break policy (R7-1) every text boundary
 *                          uses
 *   singleLineText         model text shown as one run of words (R9-1, R9-2):
 *                          the line-break policy, then every whitespace run
 *                          as one space — quoteClaim and the bias caveat
 *
 * Escaping is applied once, here, at serialization. Stored text, claim
 * identity and the HTML / DOCX / PDF renderers (which escape for their own
 * format) are untouched. Application-generated headings and computed text are
 * written by the builders and never pass through these functions.
 * Pure and client-safe.
 */

/**
 * Line breaks (R7-1): every sequence a Markdown parser or a plain-text viewer may end a line at — CRLF, a lone CR
 * and LF (CommonMark's line endings), and NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR (Unicode line breaks some
 * viewers honour). The one definition every boundary below, and quoteClaim, applies: model text that must stay on
 * one line has each break turned into a space; model prose keeps its lines, each one quoted.
 */
const LINE_BREAK_SOURCE = String.raw`\r\n|[\r\n\u0085\u2028\u2029]`;
const LINE_BREAK = new RegExp(LINE_BREAK_SOURCE);
/** A line break with the spaces and tabs around it. */
const LINE_BREAK_IN_BLANKS = new RegExp(String.raw`[ \t]*(?:${LINE_BREAK_SOURCE})[ \t]*`, "g");
/** A line break with any whitespace around it, other line breaks included. */
const LINE_BREAK_IN_WHITESPACE = new RegExp(String.raw`[\s\u0085]*(?:${LINE_BREAK_SOURCE})[\s\u0085]*`, "g");

/** Text split into its lines at every line break. */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/**
 * Text that must stay on one line: each line break becomes one space — with the spaces and tabs around it
 * ("blanks"), or with every whitespace character around it, so a run of breaks is one space ("whitespace").
 */
export function joinLines(text: string, absorb: "blanks" | "whitespace" = "blanks"): string {
  return text.replace(absorb === "blanks" ? LINE_BREAK_IN_BLANKS : LINE_BREAK_IN_WHITESPACE, " ");
}

/** A run of whitespace: every character JavaScript's \s matches (tab, VT, FF, NBSP, U+2000–U+200A, U+3000, BOM, …) and NEL. */
const WHITESPACE_RUN = /[\s\u0085]+/gu;

/**
 * Model text shown as one run of words (R9-1, R9-2): every line break (joinLines), then every run of whitespace, is
 * one ordinary space, and the ends are trimmed. A renderer that wraps by width (react-pdf) cannot break inside a run
 * of spaces or tabs, so a long run would push the words after it to the start of a new line — the same effect as a
 * line break. Display only: callers keep the stored text.
 */
export function singleLineText(text: string): string {
  return joinLines(text, "whitespace").replace(WHITESPACE_RUN, " ").trim();
}

/** CommonMark/GFM characters that can start inline structure or HTML anywhere in a line ("@": GFM email autolinks). */
const INLINE_SPECIAL = /([\\`*_[\]#<>|~&@])/g;

/**
 * GFM autolink literals ("http://…", "www.…"): the URL stays visible as text but is not made a link. Matched
 * wherever they occur, not only at a word boundary (R7-2): parsers link a URL after "_", a digit or a letter too.
 * The scheme is bounded (URI schemes are short), so the scan stays linear.
 */
const AUTOLINK_LITERAL = /([A-Za-z][A-Za-z0-9+.-]{0,31}):(?=\/\/)|(www)\.(?=\S)/gi;

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
  return escapeMarkdownLine(joinLines(text));
}

/**
 * Model-written prose as a Markdown blockquote: every line quoted and escaped; blank lines stay inside the quote
 * (paragraphs), and a line followed by another line ends in a hard break so the model's line breaks are kept.
 */
export function markdownQuote(text: string, indent = ""): string[] {
  const all = splitLines(text);
  return all.map((line, i) => {
    if (!line.trim()) return `${indent}>`;
    const next = all[i + 1];
    return `${indent}> ${escapeMarkdownLine(line)}${next !== undefined && next.trim() ? "\\" : ""}`;
  });
}

/** Model-written prose for plain text: every line prefixed with "> " so the block stays one quoted unit. */
export function plainTextQuote(text: string, indent = ""): string[] {
  return splitLines(text).map((line) => (line.trim() ? `${indent}> ${line}` : `${indent}>`));
}
