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

