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

export const RunSlotStatusContext = createContext<ReadonlyMap<string, string> | null>(null);

export function useRunSlotStatus(): ReadonlyMap<string, string> | null {
  return useContext(RunSlotStatusContext);
}

/** A slot the run records as not having responded (any status other than ok/substituted). Unknown → false. */
export function slotDidNotRespond(statuses: ReadonlyMap<string, string> | null, modelId: string): string | null {
  const status = statuses?.get(modelId);
  if (typeof status !== "string" || status.length === 0) return null;
  return status === "ok" || status === "substituted" ? null : status;
}

/** Fixed, system-authored wording for a recorded non-response. Never provider error text. */
export function didNotRespondText(status: string): string {
  if (status === "timeout") return "did not respond in time and was excluded from comparison.";
  if (status === "refused") return "declined to answer and was excluded from comparison.";
  if (status === "rate_limited") return "was rate-limited by its provider and was excluded from comparison.";
  return "did not respond (the provider returned an error) and was excluded from comparison.";
}
