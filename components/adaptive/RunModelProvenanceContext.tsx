"use client";

/**
 * The per-slot model provenance of the run an adaptive report belongs to,
 * provided once by the component that holds the run's result rows
 * (ResultsDisplay) and read by the adaptive surfaces that name a model's
 * identity (per-model response headers, the memo's model list).
 *
 * `null` (the default) means "this surface was not handed the run's record":
 * consumers then name models by family only (see `runModelLabels`) and never
 * claim a model was "not recorded" for a record they never saw.
 */

import { createContext, useContext } from "react";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";

export const RunModelProvenanceContext = createContext<readonly RunModelProvenanceFacts[] | null>(null);

export function useRunModelProvenance(): readonly RunModelProvenanceFacts[] | null {
  return useContext(RunModelProvenanceContext);
}
