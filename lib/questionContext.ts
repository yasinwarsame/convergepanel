import { MAX_QUESTION_LENGTH } from "@/lib/security/requestValidation";

/**
 * Helper to split a single textarea input into QUESTION and optional CONTEXT.
 *
 * Users can write:
 * Question: ...
 * Context: ...
 * Anything after a line that starts with "Context:" (case-insensitive) is treated
 * as supporting material / source text. If no Context: is present, the whole
 * input is treated as the question.
 */
export function splitQuestionAndContext(raw: string): { question: string; context: string | null } {
  const lines = raw.split(/\r?\n/);
  const contextIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith("context:"));

  if (contextIndex === -1) {
    const fallback = raw.trim();
    return { question: fallback, context: null };
  }

  const questionLines = lines.slice(0, contextIndex);
  const contextLines = lines.slice(contextIndex); // keep the "Context:" line for clarity

  const question = questionLines.join("\n").trim();
  const context = contextLines.join("\n").trim();

  // Be defensive: if question ended up empty, fall back to the raw input.
  return {
    question: question.length > 0 ? question : raw.trim(),
    context: context.length > 0 ? context : null,
  };
}

/**
 * Governance input authority (F2, R1) — the server-split `context` persisted
 * on a run as `questionContext`, so a later synthesis can rebuild what the
 * panel models received WITHOUT trusting the client's copy.
 *
 * Stored verbatim as `splitQuestionAndContext` returned it (it keeps its own
 * leading "Context:" line). The request already passed the 10,000-character
 * question limit and the context is a part of it, so the cap below is a
 * defensive restatement of that same contract, never a new allowance.
 * Absent/empty context → `undefined`, so no empty field is ever written.
 */
export function persistableQuestionContext(context: string | null | undefined): string | undefined {
  if (typeof context !== "string") return undefined;
  const trimmed = context.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_QUESTION_LENGTH);
}

/**
 * The question a synthesis is given: the stored question alone, or — when the
 * run persisted a context — the question followed by that context, as the
 * models saw both. Never adds a "Context:" section that was not persisted.
 */
export function composeSynthesisQuestion(question: string, questionContext?: string): string {
  return questionContext ? `${question}\n\n${questionContext}` : question;
}
