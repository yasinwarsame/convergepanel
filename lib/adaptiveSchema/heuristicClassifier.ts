/**
 * Independent risk check for classifier fallbacks (owner final ruling, 2026-11-02).
 *
 * When the model classifier cannot complete, the run ALWAYS falls back to Generic (classifier.ts). This module selects
 * NO answer type. It only reports whether a question's wording is health-, legal-, finance- or safety-sensitive, so the
 * generic fallback can keep an elevated riskLevel instead of the default "professional".
 *
 * It is not a safety classifier and not proof that a question is safe: an unlisted sensitive question simply keeps the
 * default level. The term list is deliberately not expanded to chase examples (owner ruling).
 */


/** Health, legal, financial and safety wording that keeps an elevated riskLevel on a generic fallback (see the header). */
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
