/**
 * #290 Increment 1 — what kind of answer a report actually holds, as a pure view model.
 *
 * The heading "Answer" is used only when a written synthesis exists. A degraded report (the synthesis step failed and
 * the summary was assembled from scored claims) is never headed "Answer"; a stored degraded flag that is not a boolean
 * is "unknown", never assumed written; no report at all is "missing" and no answer text is shown.
 *
 * Reads the stored report only; computes nothing. UI-only (readableImportBoundary.spec.ts).
 */
import type { AdaptiveSynthesisReport } from "@/lib/adaptiveSchema/types";
import { READABLE_ANSWER_COPY } from "./copy";

export type ReadableAnswerStatus = "written" | "assembled" | "unknown" | "missing";

export function readableAnswerStatus(report: Pick<AdaptiveSynthesisReport, "degraded"> | null | undefined): ReadableAnswerStatus {
  if (!report) return "missing";
  const degraded: unknown = report.degraded;
  if (degraded === false) return "written";
  if (degraded === true) return "assembled";
  return "unknown";
}

export function readableAnswerHeading(status: ReadableAnswerStatus): string {
  switch (status) {
    case "written":
      return READABLE_ANSWER_COPY.writtenHeading;
    case "assembled":
      return READABLE_ANSWER_COPY.assembledHeading;
    case "unknown":
      return READABLE_ANSWER_COPY.unknownHeading;
    case "missing":
      return READABLE_ANSWER_COPY.missingHeading;
  }
}

/** Whether answer text from the report may be shown at all: never for a missing report. */
export function readableAnswerHasBody(status: ReadableAnswerStatus): boolean {
  return status !== "missing";
}
