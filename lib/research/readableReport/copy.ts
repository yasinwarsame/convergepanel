/**
 * #290 Increment 1 — every new user-facing literal of the readable report layout, in one place.
 *
 * UI-only. Exports, persisted report text, share / memo builders and the consensus engine never read this module
 * (readableImportBoundary.spec.ts), so these words change nothing outside the readable layout. Where an existing fixed
 * wording already says what is needed (gatePresentation's gate words and notices, the analysis-availability lines), the
 * readable layout reads that wording instead of restating it.
 *
 * Rules the wording follows (trustSignals.spec.ts and components/research/readable/__tests__/readableReport.spec.tsx assert
 * them):
 *   - the verification gate is never called consensus or agreement, and Pass is never called "verified";
 *   - counts are stated with both numbers; a value with no denominator is "N/A" / "Not recorded", never a percentage;
 *   - nothing here checks sources or answer accuracy, and the copy never says it does.
 *
 * These definitions are also the human-readable counterpart of the trust semantics a future API-1 would expose
 * (proposal §5); no API field is added here.
 */

export const READABLE_ANSWER_COPY = {
  /** A written synthesis exists (synthesisReport.degraded === false). */
  writtenHeading: "Answer",
  /** synthesisReport.degraded === true: the summary was assembled from the scored claims, not written. */
  assembledHeading: "Panel summary (assembled from scored claims; no written synthesis was produced)",
  /** A stored degraded flag that is not a boolean: whether a written synthesis exists is unknown. */
  unknownHeading: "Panel summary (whether a written synthesis was produced is not recorded)",
  unknownNote: "This report does not record whether its summary was written by the synthesis step or assembled from scored claims.",
  /** No synthesis report at all. */
  missingHeading: "No combined answer",
  missingBody: "No synthesis was recorded for this run, so no combined answer is shown. Each model's own response is available below.",
  missingLink: "Go to Model Responses",
  /** The existing strip's labels for the top point / key point / empty key point, kept as they are. */
  topPointLabel: "Models agree",
  keyPointLabel: "Models disagree",
  noKeyPoint: "No major disagreements detected.",
} as const;

export const READABLE_TRUST_COPY = {
  heading: "Trust signals",
  intro: "Four separate signals, each measuring something different. None of them checks the answer against outside sources.",

  gateName: "Verification gate",
  gateDefinition:
    "An automated rule applied to the panel's stored certainty score and to its most-raised claims. It does not check the answer against outside sources.",
  gateNotRecorded: "Not recorded",
  gateNotRecordedDetail: "No verification gate was recorded for this run.",
  gateInputsHeading: "Stored inputs",
  gateCertainty: (percent: number) => `Certainty score: ${percent}%`,
  gateSplitTop: (split: number, top: number) => `Most-raised claims with a split position: ${split} of ${top}`,
  gateInputsNotRecorded: "The gate's stored inputs are not available on this page.",

  coverageName: "Panel coverage",
  coverageDefinition:
    "How many of the models asked actually responded, and how many claims have positions from at least two models. It counts responses; it does not measure agreement.",
  coverageResponded: (responded: number, dispatched: number, substituted = 0) =>
    substituted > 0
      ? `Responded: ${responded} of ${dispatched} dispatched, including ${substituted} answered by a substitute model`
      : `Responded: ${responded} of ${dispatched} dispatched`,
  coverageSubstitutedDetail: (substituted: number) =>
    `${substituted} of the dispatched models did not answer themselves; a different model answered in ${substituted === 1 ? "its" : "their"} place.`,
  coverageUnknownStatus: (unknown: number, dispatched: number) => `Response status not recorded for ${unknown} of ${dispatched}`,
  coverageNoStatus: "Response status not recorded",
  coverageModelsInReport: (n: number) => `Models in this report: ${n}`,
  coverageClaims: (multi: number, total: number) => `Claims with positions from 2 or more models: ${multi} of ${total}`,
  coverageNoClaims: "No claims were compared for this report.",

  sourcesName: "Sources",
  sourcesDefinition:
    "Whether models named a source for the values this report type asks them to source. Sources are named by the models and are not checked.",
  sourcesNotRequested: "N/A (no source-scored values)",
  sourcesNotRequestedDetail:
    "This report type asks for no values that are scored for a named source. Any authorities or sources a model mentions in its text are not counted here.",
  sourcesNamed: (named: number, total: number) => `Named: ${named} of ${total} values`,
  sourcesNamedDetail: "Named by models, not checked.",
  sourcesNone: (total: number) => `None recorded (0 of ${total} values)`,
  sourcesNoneDetail: "No model named a source for the values this report type asks them to source.",

  behaviourName: "Model behaviour score",
  behaviourDefinition:
    "A stored score that combines citation presence, how often each model's position matched the most common one, and contradictions. It describes how the models behaved, not whether the answer is correct.",
  behaviourNotScored: "Not scored",
  behaviourNotScoredDetail: "No model behaviour score was recorded for this run.",
  behaviourValue: (percent: number) => `${percent}% (stored score)`,
  behaviourCitationNotApplicable:
    "Citations: N/A for this report type. The stored score counts that part as full marks because no values are scored for sources, which raises it.",
  behaviourCitationNoValues:
    "Citations: no response gave a value to source. The stored score counts that part as full marks, which raises it.",
  /**
   * The per-model stored score in the Model Responses list, named as the panel names it (ListView's ListScoreNames;
   * review M-1 on 6bcc234 — the readable page states no "Panel reliability" and no per-model citation percentages).
   */
  listScoreRow: (percent: number) => `behaviour score ${percent}%`,
  listScoreSort: "behaviour score",
  listScoreCapped: "degraded · score capped",

  behaviourCitationPartial: (vacuous: number, parsed: number) =>
    `Citations: ${vacuous} of ${parsed} parsed responses gave no value to source. The stored score counts that part as full marks for ${vacuous === 1 ? "that response" : "those responses"}, which raises it.`,
} as const;
