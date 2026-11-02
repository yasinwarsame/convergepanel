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

/**
 * Owner final ruling (2026-11-02, PR #275 closeout): the fallback may select only Forecast or Generic.
 *
 *   - Owner's table: Comparison and Forecast, and only as PRESENTATION-ONLY fallbacks. "If an existing comparison or
 *     forecast schema has such side effects, the fallback must use Generic instead."
 *   - comparison_matrix is a Milestone-2 schema. Its envelope triggers initializeAdaptiveGovernanceRecord: a governance
 *     record with a decision receipt, automated governance, and Team review routing when the receipt needs human
 *     review (runPanelExecution.ts, `if (adaptiveOutput.persistedOutput)`). A fallback comparison therefore stays
 *     Generic, and no comparison rule exists.
 *   - forecast_speculative is legacy-active: it persists only the legacy envelope (no governance record, receipt or
 *     Team review) and exports through the same legacy family as generic. So it is presentation-only, and it is the
 *     one fallback target.
 *   - Procedure, causal, risks, ranking, definition and Decision Support are never fallback targets.
 *   - The structural test requires every target to be a legacy-active (non-Milestone-2) schema.
 *
 * SENSITIVE / SAFETY_CRITICAL only raise the independent risk flag and keep a sensitive forecast generic. They are not
 * expanded to chase examples (owner ruling).
 */
/**
 * Final verification MINOR-1 / MINOR-2 (structural guards, not keyword lists):
 *   - a question that opens as a procedure or decision request is not a forecast (owner table: procedure/decision →
 *     Generic), e.g. "How do I forecast revenue?" or "Should we raise prices by 2030?";
 *   - a first-person question is about the asker's own situation (health, safety, money), not a public forecast. It
 *     stays Generic whether or not it names a listed term, e.g. "Will my lump grow in the next 6 months?".
 */
const PROCEDURE_OR_DECISION = /^\s*(how|why|should|shall|what should|what can|what do|what would you|can (i|we|you)|could (i|we|you)|do (i|we))\b/i;
const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|im|me|my|mine|myself)\b/i;

export const HEURISTIC_RULES: readonly HeuristicRule[] = [
  // A future time horizon, or "Will …" with a change verb. A bare "Will this compile?" or "Will you help?" is not a forecast.
  {
    id: "forecast",
    queryType: "forecast_speculative",
    test: (q) =>
      !PROCEDURE_OR_DECISION.test(q) &&
      !FIRST_PERSON.test(q) &&
      (futureYearHorizon(q) ||
      /\bin the next \d+ (years?|months?|decades?)\b|\bforecast\b|^\s*will\b.*\b(eliminate|replace|increase|decrease|rise|fall|grow|decline|overtake|surpass|outnumber|collapse|recover|disappear)\b/i.test(q)),
  },
];

/** The rule that matches, or null (keep generic). Pure. */
export function heuristicClassify(query: string): { queryType: QueryType; ruleId: string } | null {
  const q = query.trim();
  // Review R3: the routing guard covers the safety-critical list as well as SENSITIVE.
  if (!q || sensitiveTopic(q) !== null) return null;
  for (const rule of HEURISTIC_RULES) {
    if (rule.test(q)) return { queryType: rule.queryType, ruleId: rule.id };
  }
  return null;
}
