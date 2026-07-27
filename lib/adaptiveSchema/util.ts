/**
 * Small shared helpers used across the classifier, validator, and alignment
 * modules. Kept minimal and dependency-free.
 */

/** Strip a leading/trailing ```json ... ``` or ``` ... ``` fence, if present. */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Truncate text to at most maxWords words, appending an ellipsis if cut. */
export function truncateWords(text: string, maxWords: number): { text: string; truncated: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return { text: text.trim(), truncated: false };
  }
  return { text: `${words.slice(0, maxWords).join(" ")}…`, truncated: true };
}

/**
 * Race a promise against a timeout, clearing the timer either way so a
 * resolved/rejected promise never leaves a dangling setTimeout behind.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
