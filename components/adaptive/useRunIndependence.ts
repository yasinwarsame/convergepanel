"use client";

/**
 * The run's model independence for a UI surface (verdictIndependence.shownRunIndependence): the qualified report view's
 * verdict when the surface holds that view, else the run's recorded per-slot rows (a marked report's boundary
 * provenance first, then the page's). Null — the surface renders exactly as before — for a run whose every slot is its
 * own recorded executing model, or when the surface was not handed the run's rows.
 */

import { usePositionPresentation } from "./PositionPresentationContext";
import { useRunModelProvenance } from "./RunModelProvenanceContext";
import { shownRunIndependence, type QualifiedIndependence } from "@/lib/adaptiveSchema/verdictIndependence";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";

/** The provenance a surface judges rows by: a marked boundary's, else the page's. */
export function useJudgingProvenance(): readonly RunModelProvenanceFacts[] | null {
  const position = usePositionPresentation();
  const page = useRunModelProvenance();
  return position?.provenance ?? page;
}

export function useRunIndependence(report?: unknown): QualifiedIndependence | null {
  return shownRunIndependence(report, useJudgingProvenance());
}
