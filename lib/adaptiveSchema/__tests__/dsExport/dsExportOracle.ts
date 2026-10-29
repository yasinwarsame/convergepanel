/**
 * Order 6 / S-E.2: the literal oracle for version-1 Decision Support exports. Written from the owner rulings (K-1 E-1/E-2,
 * K-5, K-6, O-2, O-3, D-9) and the S-E.1 oracle, never from the wording module, so a wrong constant fails here.
 */
export const LABEL_AGREEMENT = "Model agreement";
export const LABEL_SOURCES = "Sources";
export const NO_DISAGREEMENT = "No disagreement identified by current grouping";
export const PROVIDED = "Sources provided by models; not independently verified";
export const NONE = "No sources listed";
export const D9 =
  "Options were grouped by text similarity. Different options with similar wording (for example 3.5% vs 35%, or Approve vs Disapprove) can be merged; agreement on an option is not established.";
export const OLD_CAPTION =
  "Consensus reflects panel agreement, not factual correctness. Source grounding reflects citation coverage, not evidence strength.";
export const STORED_488 = "Models agree a specific option should be chosen but did not name one this system could confidently resolve.";
export const SHOWN_488 = "The current grouping could not reliably identify the recommended option. Review the individual model recommendations before deciding.";

export type Oracle = { agreement: string; sources: string; d9: boolean; conclusion488: "presented" | "stored" | null };

/** Per DS state (dsExportFixtures.dsStates). `conclusion488`: whether the receipt conclusion is the :488 one, and how it shows. */
export const ORACLE: Record<string, Oracle> = {
  uncontested_choose_option: { agreement: NO_DISAGREEMENT, sources: PROVIDED, d9: true, conclusion488: null },
  uncontested_go_with_failed_slots: { agreement: NO_DISAGREEMENT, sources: PROVIDED, d9: true, conclusion488: null },
  contested_on_action: { agreement: "Split", sources: PROVIDED, d9: true, conclusion488: null },
  contested_on_option: { agreement: "Split", sources: PROVIDED, d9: true, conclusion488: null },
  no_recommendation: { agreement: "Not scored", sources: PROVIDED, d9: true, conclusion488: null },
  no_recommendation_no_options: { agreement: "Not scored", sources: PROVIDED, d9: false, conclusion488: null },
  all_models_failed: { agreement: "Not scored", sources: NONE, d9: false, conclusion488: null },
  single_model: { agreement: NO_DISAGREEMENT, sources: PROVIDED, d9: true, conclusion488: null },
  merged_opposite_options: { agreement: NO_DISAGREEMENT, sources: PROVIDED, d9: true, conclusion488: null },
  blank_source_list: { agreement: NO_DISAGREEMENT, sources: NONE, d9: true, conclusion488: null },
  no_sources: { agreement: NO_DISAGREEMENT, sources: NONE, d9: true, conclusion488: null },
  high_stakes_review_needed: { agreement: NO_DISAGREEMENT, sources: PROVIDED, d9: true, conclusion488: null },
  unresolved_option_488: { agreement: "Split", sources: PROVIDED, d9: true, conclusion488: "presented" },
  split_option_498: { agreement: "Split", sources: PROVIDED, d9: true, conclusion488: null },
  partial_option_resolution_498: { agreement: "Split", sources: PROVIDED, d9: true, conclusion488: null },
  conditional_go_collision_488: { agreement: NO_DISAGREEMENT, sources: PROVIDED, d9: true, conclusion488: "stored" },
  legacy_no_sources_field: { agreement: NO_DISAGREEMENT, sources: "—", d9: true, conclusion488: null },
  legacy_unsourced: { agreement: NO_DISAGREEMENT, sources: NONE, d9: true, conclusion488: null },
};

/** Keys and text of a Decision Support provenance view; none may appear in any export (§3.4). */
export const PROVENANCE_MARKERS = ["dsProvenance", "ds_provenance_min", "useAuthorization", "DS_PROVENANCE", "provenanceView"];

/** "ds.<state>.<governance>" → state name. */
export const stateOf = (caseName: string): string => caseName.split(".")[1];

/**
 * R2 MINOR-1: the complete version-1 DOCX status region, literal and in order, so any change to version-1 DOCX wording
 * (an added paragraph, a renamed row, a different value, D-9 moved, duplicated or dropped) fails, not only a claim the
 * scanner families catch. The labels are written out upper-case here, never derived from the wording module or from
 * LABEL_* above. The Models value is the fixture's panel through the shared identity rendering (unchanged from
 * historical exports), written out per state.
 */
const NR = (name: string, failed = false) => `${name} · model not recorded${failed ? " (failed)" : ""}`;
const THREE = [NR("ChatGPT"), NR("Claude"), NR("Gemini")].join(", ");
const TWO = [NR("ChatGPT"), NR("Claude")].join(", ");
const ONE = NR("ChatGPT");
export const DOCX_V1_MODELS: Record<string, string> = {
  uncontested_choose_option: THREE,
  uncontested_go_with_failed_slots: [NR("ChatGPT"), NR("Claude"), NR("Gemini", true), NR("Grok", true), NR("Perplexity", true)].join(", "),
  contested_on_action: THREE,
  contested_on_option: THREE,
  no_recommendation: TWO,
  no_recommendation_no_options: TWO,
  all_models_failed: [NR("ChatGPT", true), NR("Claude", true), NR("Gemini", true)].join(", "),
  single_model: ONE,
  merged_opposite_options: TWO,
  blank_source_list: TWO,
  no_sources: ONE,
  high_stakes_review_needed: ONE,
  unresolved_option_488: TWO,
  split_option_498: THREE,
  partial_option_resolution_498: THREE,
  conditional_go_collision_488: TWO,
  legacy_no_sources_field: TWO,
  legacy_unsourced: TWO,
};
/** The R1 NIT-4 synthetic-identities case: requested models and one substitution, from its synthetic run document. */
export const DOCX_V1_MODELS_SYNTHETIC =
  "ChatGPT · requested: openai:synthetic-model-a, Claude · requested: anthropic:synthetic-model-b · substituted, answered by: Anthropic, Gemini · requested: google:synthetic-model-c";

/** Exact paragraphs from "Report status summary" up to (not including) "Conclusion" / "Primary synthesis". */
export function docxStatusRegionV1(caseName: string): string[] {
  const o = ORACLE[stateOf(caseName)];
  const models = caseName.endsWith(".synthetic_identities") ? DOCX_V1_MODELS_SYNTHETIC : DOCX_V1_MODELS[stateOf(caseName)];
  if (!o || !models) throw new Error(`no version-1 DOCX oracle for ${caseName}`);
  return ["Report status summary", "MODELS", models, "MODEL AGREEMENT", o.agreement, "SOURCES", o.sources, ...(o.d9 ? [D9] : [])];
}
