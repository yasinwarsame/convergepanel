/**
 * D-2 (shared Adaptive Schema architecture, 2026-11-02): a deterministic fallback classifier.
 *
 * It is used ONLY when the model classifier could not complete: a connector error (Production 2026-11-01: Gemini HTTP
 * 402 on every call), a timeout, malformed JSON or a schema-invalid answer. It is never used for a model verdict of
 * low confidence; that remains `generic`, as before.
 *
 * Contract:
 *   - Maps to EXISTING `QueryType`s only. It has no taxonomy of its own and no provider call, so it costs nothing.
 *   - Precision over recall: a rule fires only on an unambiguous surface pattern. Anything else returns null, and the
 *     caller keeps `generic`. A mis-route only changes presentation: every model response still renders.
 *   - First matching rule wins. The order is fixed below and pinned by tests.
 *   - Never produces a handoff, disabled, limitation or clarification type.
 *   - Owner ruling (2026-11-02, PR #275 review MAJOR-1 / MINOR-3), "narrow the fallback":
 *       - Never chooses `decision_support`. That schema creates governance records, decision receipts and Team review,
 *         and is exported as "Decision support". None of that may come from a fallback guess.
 *       - A health-, legal- or finance-sensitive question is never routed (SENSITIVE below). It stays `generic`, keeping
 *         the general format and its conservative metadata rather than a format chosen without its risk signals.
 */

import type { QueryType } from "./types";

export type HeuristicRule = { id: string; queryType: QueryType; test: (query: string) => boolean };

/** Health, legal and financial subject matter: never routed by the fallback (owner ruling, see the header). */
export const SENSITIVE =
  /\b(suicid\w*|kill (myself|himself|herself|themselves)|medic(al|ine|ation)s?|doses?|dosage|insulin|symptoms?|diagnos\w*|treatments?|therap\w*|pregnan\w*|surger\w*|cancer|disease|prescri\w*|drugs?|vaccin\w*|mental health|suicid\w*|self-harm|overdose|legal(ly)?|lawsuit|sue|contracts?|attorney|lawyer|court|visa|immigration|taxe?s?|invest(ing|ment)?s?|stocks?|loans?|mortgage|retirement|pension)\b/i;

/** Self-harm and acute-danger terms: the highest risk level. A subset of SENSITIVE. */
const SAFETY_CRITICAL = /\b(suicid\w*|self-harm|overdose|kill (myself|himself|herself|themselves))\b/i;

/**
 * Ruling A (2026-11-02): a sensitive question keeps the generic format, but its risk signal is NOT dropped. The
 * returned level feeds the same riskLevel-driven safeguards a model classification would: the export classification
 * floor, the views' high-stakes warnings and analytics. Pure; null for anything not sensitive.
 */
export function sensitiveTopic(query: string): "safety_critical" | "high_stakes" | null {
  const q = query.trim();
  if (!q) return null;
  if (SAFETY_CRITICAL.test(q)) return "safety_critical";
  return SENSITIVE.test(q) ? "high_stakes" : null;
}

const re = (pattern: RegExp) => (q: string) => pattern.test(q);

/** "by 2031" counts as a forecast horizon only when the year is in the future (review MINOR-2: past years are not forecasts). */
function futureYearHorizon(q: string): boolean {
  const thisYear = new Date().getUTCFullYear();
  for (const m of q.matchAll(/\bby (\d{4})\b/gi)) if (Number(m[1]) > thisYear) return true;
  return false;
}

/** Ordered. "What are the risks of …" must reach checklist before any later rule could claim it. */
export const HEURISTIC_RULES: readonly HeuristicRule[] = [
  // Review MINOR-2: anchored. "Write a poem comparing…" or "Is this real? compare frames" is not a comparison grid.
  { id: "comparison", queryType: "comparison_matrix", test: re(/^\s*compare\b|\b(vs\.?|versus)\b|^\s*what (is|are) the differences? between\b/i) },
  { id: "risks_or_tradeoffs", queryType: "checklist_taxonomy", test: re(/^\s*(what are the (main |key |biggest )?risks\b|what are the pros and cons\b|pros and cons of\b)/i) },
  { id: "causal", queryType: "causal_explanation", test: re(/^\s*(why (did|do|does|is|are|was|were|has|have)\b|what (caused|causes|led to|drives|drove)\b)/i) },
  // A future time horizon, or "Will …" with a change verb. A bare "Will this compile?" or "Will you help?" is not a forecast.
  {
    id: "forecast",
    queryType: "forecast_speculative",
    test: (q) =>
      futureYearHorizon(q) ||
      /\bin the next \d+ (years?|months?|decades?)\b|\bforecast\b|^\s*will\b.*\b(eliminate|replace|increase|decrease|rise|fall|grow|decline|overtake|surpass|outnumber|collapse|recover|disappear)\b/i.test(q),
  },
  { id: "procedure", queryType: "procedural", test: re(/^\s*(how (do|can|should) (i|we|you)\b|how to\b|what are the steps\b|steps to\b)/i) },
  { id: "ranking", queryType: "ranked_enumeration", test: re(/^\s*(what are the |list the |name the )?(top|best) \d+\b/i) },
  { id: "definition", queryType: "definition_explanation", test: re(/^\s*(define\b|definition of\b|what does .{1,80} mean\b)/i) },
];

/** The rule that matches, or null (keep generic). Pure. `requestedCount` is carried for a "top N" ranking (review MINOR-3). */
export function heuristicClassify(query: string): { queryType: QueryType; ruleId: string; requestedCount: number | null } | null {
  const q = query.trim();
  if (!q || SENSITIVE.test(q)) return null;
  for (const rule of HEURISTIC_RULES) {
    if (rule.test(q)) {
      const n = rule.queryType === "ranked_enumeration" ? /\b(?:top|best) (\d+)\b/i.exec(q) : null;
      return { queryType: rule.queryType, ruleId: rule.id, requestedCount: n ? Number(n[1]) : null };
    }
  }
  return null;
}
