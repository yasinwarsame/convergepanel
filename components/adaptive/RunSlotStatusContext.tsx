"use client";

/**
 * D-4 (shared Adaptive Schema architecture, 2026-11-02): the per-slot call status the run recorded, for each model.
 * `ResultsDisplay` provides it from the run rows it already holds (live or saved).
 *
 * Why it exists: the adaptive builder validates a slot that did not respond as if it had returned empty text
 * (`parseError: "Empty response"`). The comparison notes then said the model "returned an incompatible format",
 * which is false for a provider failure: in Production, Gemini returned HTTP 402 before any response existed. With
 * this record the notes can say what happened without changing the builder output that the frozen baselines pin.
 *
 * `null` (the default) means the surface was not handed the run's record. Consumers then keep their original wording,
 * because they cannot tell a provider failure from a format failure.
 */

import { createContext, useContext } from "react";
import { isRecordedFailureStatus, recordedSlotOutcome } from "@/lib/panel/persistedStatusOutcome";

export const RunSlotStatusContext = createContext<ReadonlyMap<string, string> | null>(null);

export function useRunSlotStatus(): ReadonlyMap<string, string> | null {
  return useContext(RunSlotStatusContext);
}

/**
 * A slot the run RECORDS as not having responded: its status is an exact recorded failure literal of the ONE shared
 * status map (lib/panel/persistedStatusOutcome.ts — failed / error / timeout / refused / rate_limited; Order 30 round 2,
 * review m-E). An answer (ok / substituted), a missing value, or any crafted / unrecognized status ("OK ", "Ok",
 * "pending", "toString", …) is unknown → null, and the consumer keeps its original wording.
 */
export function slotDidNotRespond(statuses: ReadonlyMap<string, string> | null, modelId: string): string | null {
  const status = statuses?.get(modelId);
  return isRecordedFailureStatus(status) ? (status as string) : null;
}

/**
 * Order 31 (review n-E): a slot whose recorded call status is present but is not an exact literal of the shared status
 * map ("OK ", "pending", "toString", …). What happened to that call is unknown, so it is never described as a format
 * failure ("returned an incompatible format" asserts a response). An empty or missing status (a row from before statuses
 * were recorded) is not judged here — the consumer keeps its original wording, as without the record.
 */
export function slotStatusUnrecognized(statuses: ReadonlyMap<string, string> | null, modelId: string): boolean {
  const status = statuses?.get(modelId);
  return typeof status === "string" && status !== "" && recordedSlotOutcome(status) === null;
}

/** The fixed wording for such a slot (vocabulary manifest). */
export const UNRECOGNIZED_STATUS_TEXT = "has a recorded call status this version does not recognize, so what happened is not stated; it was excluded from comparison.";

/**
 * Fixed, system-authored wording for a recorded non-response. Never provider error text.
 *
 * Saved and live rows normally reach this point only as ok / substituted / failed (panel.ts's failedPlaceholder,
 * normalize.ts). "failed" covers timeouts, refusals and errors alike, so the default claims no cause (review MINOR-1).
 * The specific wordings apply only when a row records that specific status.
 */
export function didNotRespondText(status: string): string {
  if (status === "timeout") return "did not respond in time and was excluded from comparison.";
  if (status === "refused") return "declined to answer and was excluded from comparison.";
  if (status === "rate_limited") return "was rate-limited by its provider and was excluded from comparison.";
  return "did not respond and was excluded from comparison.";
}
