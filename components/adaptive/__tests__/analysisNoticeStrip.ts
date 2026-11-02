/**
 * Test-only helper for the frozen-baseline parity suites (D-3, 2026-11-02).
 *
 * The owner-approved AnalysisAvailabilityNotice is the one permitted addition on reports whose synthesis is degraded
 * (or whose classification fell back). It is removed before comparing against baselines captured before it existed.
 *
 * Exactness (PR #275 review MINOR-5): the pattern matches ONLY the real notice. That means its fixed wrapper, then one
 * or two of the component's own exported lines, in the order the component emits them, HTML-escaped exactly as
 * renderToStaticMarkup escapes them. An invented, altered or extra line, or any other markup, does not match, so it
 * still fails the frozen comparison. Callers also assert the count (exactly one per affected output).
 */
import { ANALYSIS_NOTICE_LINES } from "@/components/adaptive/AnalysisAvailabilityNotice";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const p = (line: string) => `<p>${escapeRe(escapeHtml(line))}</p>`;

/** The only emitted sequences: an optional classification block (general format, optionally followed by the sensitive caution), then the optional degraded line. */
const CLASSIFICATION = `${p(ANALYSIS_NOTICE_LINES.generalFormat)}(?:${p(ANALYSIS_NOTICE_LINES.sensitive)})?`;
const DEGRADED = p(ANALYSIS_NOTICE_LINES.degraded);
const BODY = `(?:${CLASSIFICATION}${DEGRADED}|${CLASSIFICATION}|${DEGRADED})`;
const NOTICE_HTML = new RegExp(
  `<div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status" data-testid="analysis-availability-notice">${BODY}</div>`,
  "g"
);

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
