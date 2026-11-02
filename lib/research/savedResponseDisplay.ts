/**
 * Presentation helpers for SAVED research shown without a persisted analysis (Team presentation fix, 2026-11-02).
 *
 * Pure and client-safe: no fetch, no provider call, no write. Nothing here changes stored data; it only decides how
 * saved text is displayed.
 */
import { stripJsonFences } from "@/lib/adaptiveSchema/util";

/** Responses longer than this are shown as saved text, never parsed. */
export const MAX_STRUCTURED_PARSE_CHARS = 200_000;
/** Structured values nested deeper than this are shown as saved text (the readable renderer recurses). */
export const MAX_STRUCTURED_DEPTH = 12;

function withinDepth(value: unknown, maxDepth: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d >= maxDepth) return false;
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) stack.push([child, d + 1]);
  }
  return true;
}

/**
 * The parsed value when a saved model response is a JSON object or array (bare, or inside a ```json fence) within the
 * size and depth bounds; otherwise null, and the caller shows the saved text as it is. A bare JSON scalar is not
 * treated as structured. JSON.parse only: nothing model-provided is ever evaluated.
 */
export function parseStructuredResponse(text: string): object | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_STRUCTURED_PARSE_CHARS) return null;
  const candidate = stripJsonFences(text);
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  return withinDepth(parsed, MAX_STRUCTURED_DEPTH) ? (parsed as object) : null;
}

/**
 * The product's former empty-state copy (removed in #274). A question that ends with it, once or repeated, carries
 * page text that was pasted along with the question; the display drops only that exact trailing copy.
 */
export const LEGACY_EMPTY_STATE_SENTENCE = "Run the panel to generate the trust summary, Agreement / Disagreement Map, and panel responses.";
const LEGACY_EMPTY_STATE_HEADING = "No unified answer yet";

/**
 * Display-only. Removes trailing repetitions of the exact legacy empty-state copy (optionally preceded by its exact
 * heading). Anything else, including a question that merely mentions similar words, is returned unchanged, and a
 * question made only of that copy is returned unchanged rather than displayed as empty. The stored record is never
 * modified.
 */
export function displayResearchQuestion(question: string): string {
  if (typeof question !== "string") return question;
  let out = question.trimEnd();
  let changed = false;
  for (;;) {
    if (!out.endsWith(LEGACY_EMPTY_STATE_SENTENCE)) break;
    let next = out.slice(0, out.length - LEGACY_EMPTY_STATE_SENTENCE.length).trimEnd();
    if (next.endsWith(LEGACY_EMPTY_STATE_HEADING)) next = next.slice(0, next.length - LEGACY_EMPTY_STATE_HEADING.length).trimEnd();
    out = next;
    changed = true;
  }
  if (!changed) return question;
  return out.length > 0 ? out : question;
}
