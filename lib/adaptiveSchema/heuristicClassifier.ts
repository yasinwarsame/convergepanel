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
export const SENSITIVE = new RegExp(
  "\\b(" +
    [
      // health (review R2 MINOR-B: everyday symptoms, conditions and medicines too)
      "my health", "health (issue|issues|problem|problems|condition|conditions|insurance|advice)", "medic(al|ine|ines|ation|ations)", "doctors?", "hospital", "pills?", "dose", "doses", "dosage", "insulin", "ibuprofen", "aspirin",
      "paracetamol", "acetaminophen", "antibiotics?", "antidepressants?", "symptoms?", "diagnosis", "diagnosed with", "treatments?", "therapy", "therapist",
      "pregnan\\w*", "surger(y|ies)", "cancer", "disease", "prescri(be|bed|ption|ptions)", "drugs?", "vaccin\\w*", "fever", "chest (pain|hurts?)",
      "blood pressure", "heart (attack|condition|disease|rate)", "diabetes", "depression", "anxiety", "mental health", "suicid\\w*", "self-harm",
      "overdose", "kill (myself|himself|herself|themselves)", "side effects?", "allerg\\w*", "infection", "injur(y|ies)", "head(ache|aches| hurts?)", "migraines?", "vomit\\w*", "nausea", "blood sugar", "uti", "urinary", "burns? (on|from|to) my", "rash", "ozempic", "wegovy", "xanax", "alcohol",
      // legal (NIT-1: specific phrases, not "sue", "court" or "visa" alone)
      "legal(ly)?", "illegal", "lawsuit", "suing", "sued", "attorney", "lawyer", "court (case|order|date|hearing)", "in court", "custody", "divorce",
      "evict(ion|ed)?", "landlord", "tenant rights", "immigration", "deport\\w*", "visa (application|status|denied|overstay)", "green card",
      "employment contract", "lease", "will and testament", "(write|make|update) (a|my) will", "restraining order", "dui", "dwi", "criminal (record|charges?)", "arrest(ed)?",
      // finance
      "tax(es)?", "invest(ing|ment|ments)?", "stocks?", "bitcoin", "ethereum", "crypto(currency|currencies)?", "loans?", "mortgage",
      "retirement", "pension", "(?<!technical )debt", "bankrupt(cy)?", "credit (card|score)", "insurance", "my savings", "savings account", "etfs?", "index funds?", "roth", "ira", "401\\(?k\\)?",
    ].join("|") +
    ")\\b",
  "i"
);

/** Self-harm and acute-danger terms: the highest risk level. A subset of SENSITIVE. */
const SAFETY_CRITICAL =
  /\b(suicid\w*|self-harm|self harm|overdose|kill (myself|himself|herself|themselves)|(hurt|harm|cut) (myself|himself|herself|themselves)|end (my|his|her|their) (own )?life|take (my|his|her|their) own life|want to die|don.?t want to (live|be alive))\b/i;

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
  // Review R3: the routing guard covers the safety-critical list as well as SENSITIVE.
  if (!q || sensitiveTopic(q) !== null) return null;
  for (const rule of HEURISTIC_RULES) {
    if (rule.test(q)) {
      const n = rule.queryType === "ranked_enumeration" ? /\b(?:top|best) (\d+)\b/i.exec(q) : null;
      return { queryType: rule.queryType, ruleId: rule.id, requestedCount: n ? Number(n[1]) : null };
    }
  }
  return null;
}
