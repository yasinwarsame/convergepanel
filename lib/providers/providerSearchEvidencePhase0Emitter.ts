/**
 * Order 5 Phase 0 — emits the Provider Search Evidence counters for a
 * Research run (called by lib/runPanelExecution.ts only while
 * PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED is on).
 *
 * One `logger.info` event per Perplexity slot (in practice one per run). The
 * payload is exactly the closed aggregate built by the pure observer —
 * counts and enums only. No uid, run id, workspace id, question, context,
 * model text, URL, domain, title, snippet, raw date or provider payload is
 * ever passed in or logged. Never throws; never writes anything.
 */

import type { ModelResult } from "@/lib/types";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import { logger } from "@/lib/logger";
import {
  AdaptiveSlotState,
  observeProviderSearchEvidence,
  PROVIDER_SEARCH_EVIDENCE_PHASE0_EVENT,
} from "./perplexitySearchEvidenceObservation";

/** The logical Perplexity panel slot. Actual provider identity is checked by the observer (`provider === "perplexity"`). */
const PERPLEXITY_SLOT = "perplexity";

function adaptiveSlotState(
  index: number,
  adaptiveExpected: boolean,
  adaptiveResults: readonly AdaptiveModelResult[] | null
): AdaptiveSlotState {
  if (!adaptiveExpected) return { kind: "none" };
  const slot = adaptiveResults?.[index];
  // Adaptive finalization failed, or produced no result aligned to this slot: fail closed.
  if (!slot || slot.modelId !== PERPLEXITY_SLOT) return { kind: "unavailable" };
  return { kind: "result", retryOutcome: slot.retryOutcome, retried: slot.retried };
}

export function emitProviderSearchEvidencePhase0(args: {
  results: readonly ModelResult[];
  adaptiveExpected: boolean;
  adaptiveResults: readonly AdaptiveModelResult[] | null;
  observedAt: Date;
}): void {
  try {
    args.results.forEach((result, index) => {
      if (result.modelId !== PERPLEXITY_SLOT) return;
      const observation = observeProviderSearchEvidence({
        result,
        adaptive: adaptiveSlotState(index, args.adaptiveExpected, args.adaptiveResults),
        observedAt: args.observedAt,
      });
      logger.info(PROVIDER_SEARCH_EVIDENCE_PHASE0_EVENT, { ...observation });
    });
  } catch (error: unknown) {
    // Observability must never affect the run. Error name only — never a message that could echo provider data.
    logger.warn("[provider-search-evidence] Phase0 observation skipped", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
