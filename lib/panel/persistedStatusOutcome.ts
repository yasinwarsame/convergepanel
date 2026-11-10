/**
 * The ONE exact-match map from a recorded slot status to its call outcome (C-a final round, Order 30 A3).
 *
 * Read by the export freeze (lib/adaptiveSchema/exportRunProvenance.ts) and by the shared presentation gate
 * (lib/panel/executionIdentity.ts: usable rows, recorded failures), so the UI and the exports cannot disagree about
 * what a status means. Keys are exactly the real `ConnectorStatus` values (lib/types.ts) and nothing else. Lookup is
 * own-property and exact: a case or whitespace variant ("OK ", "Ok"), "", a word that is not a status ("answered"),
 * a prototype key ("toString", "constructor", "__proto__", "hasOwnProperty") or a non-string is UNKNOWN (null) —
 * never a known answer and never a known failure.
 *
 * Pure, client-safe, imports nothing.
 */

export type RecordedSlotOutcome = "answered" | "failed" | "timeout" | "refused" | "rate_limited";

export const PERSISTED_STATUS_OUTCOMES: Readonly<Record<string, RecordedSlotOutcome>> = Object.freeze({
  ok: "answered",
  substituted: "answered",
  failed: "failed",
  error: "failed",
  timeout: "timeout",
  refused: "refused",
  rate_limited: "rate_limited",
});

/** The recorded outcome of an exact persisted status literal; null (unknown) for anything else. */
export function recordedSlotOutcome(status: unknown): RecordedSlotOutcome | null {
  if (typeof status !== "string" || !Object.prototype.hasOwnProperty.call(PERSISTED_STATUS_OUTCOMES, status)) return null;
  return PERSISTED_STATUS_OUTCOMES[status];
}

/** True only for an exact status literal that records a failed call (failed / error / timeout / refused / rate_limited). */
export function isRecordedFailureStatus(status: unknown): boolean {
  const o = recordedSlotOutcome(status);
  return o !== null && o !== "answered";
}

/** True only for an exact status literal that records an answer (ok / substituted). */
export function isRecordedAnswerStatus(status: unknown): boolean {
  return recordedSlotOutcome(status) === "answered";
}
