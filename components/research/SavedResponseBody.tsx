/**
 * One saved model response, shared by every saved-run view that shows responses without a persisted analysis
 * (ResponsesWithoutAnalysis and ResultsDisplay's single-response branch). Pure presentation.
 */
import { parseStructuredResponse } from "@/lib/research/savedResponseDisplay";
import StructuredResearchResult from "@/components/workspace/projects/StructuredResearchResult";

/**
 * Team presentation fix (2026-11-02): a saved response that is structured JSON (bare or fenced) is shown as readable
 * sections by the same renderer the Team composer uses, with every field kept. The exact saved text stays one click
 * away. Anything that does not parse within bounds is shown as saved text, as before.
 */
export default function SavedResponseBody({ text }: { text: string }) {
  const structured = parseStructuredResponse(text);
  if (structured === null) return <div className="whitespace-pre-wrap rounded bg-slate-50 p-4 text-sm text-slate-700" data-testid="saved-response-text">{text}</div>;
  return (
    <div className="space-y-2">
      <div className="rounded bg-slate-50 p-4" data-testid="saved-response-structured">
        <StructuredResearchResult value={structured} />
      </div>
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer">Show the saved text exactly as stored</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 text-xs text-slate-700">{text}</pre>
      </details>
    </div>
  );
}

/** A non-responding slot, described from its recorded status. */
export function notRespondedText(status: unknown): string {
  if (status === "timeout") return "did not respond in time";
  if (status === "refused") return "declined to answer";
  if (status === "rate_limited") return "was rate-limited by its provider";
  return "did not respond";
}

