/**
 * Test-only helper for the frozen-baseline parity suites (D-3, 2026-11-02).
 *
 * The owner-approved AnalysisAvailabilityNotice is the one permitted addition on reports whose synthesis is degraded
 * (or whose classification fell back). It is removed before comparing against baselines captured before it existed.
 * The callers then assert separately that it appeared exactly where the record calls for it, so removal can never
 * hide an unexpected change: anything other than the exact notice markup and lines still has to match byte for byte.
 */
import { ANALYSIS_NOTICE_LINES } from "@/components/adaptive/AnalysisAvailabilityNotice";

const NOTICE_HTML =
  /<div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status" data-testid="analysis-availability-notice">(?:<p>[^<]*<\/p>)+<\/div>/g;

export function stripAnalysisNoticeHtml(html: string): { markup: string; count: number } {
  let count = 0;
  const markup = html.replace(NOTICE_HTML, () => {
    count++;
    return "";
  });
  return { markup, count };
}

/** Removes the notice's exact lines from a reader-text capture (lines are separated by newlines or spaces). */
export function stripAnalysisNoticeText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const line of Object.values(ANALYSIS_NOTICE_LINES)) {
    while (out.includes(line)) {
      count++;
      const i = out.indexOf(line);
      const after = out[i + line.length];
      out = out.slice(0, i) + out.slice(i + line.length + (after === "\n" || after === " " ? 1 : 0));
    }
  }
  return { text: out, count };
}
