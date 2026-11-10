"use client";

/**
 * The run's model independence for a UI surface (verdictIndependence.shownRunIndependence): the qualified report view's
 * verdict when the surface holds that view, else the run's recorded per-slot rows (a marked report's boundary
 * provenance first, then the page's). Null — the surface renders exactly as before — for a run whose every slot is its
 * own recorded executing model, or when the surface was not handed the run's rows.
 */

import { usePositionPresentation } from "./PositionPresentationContext";
import { useRunModelProvenance } from "./RunModelProvenanceContext";
import { shownRunIndependence, storedSynthesisRunIndependence, type QualifiedIndependence } from "@/lib/adaptiveSchema/verdictIndependence";
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

/**
 * Order 31 R-3: the run judgement behind a schema-derived (Milestone-2) summary level. A consensus tier (strong /
 * moderate / weak) is a stored result that states agreement, so the stored-synthesis rule applies (no / too few
 * answers); any other level ("Split", "Not scored") claims no agreement and keeps the surface's own judgement
 * (`otherwise`), exactly as before.
 */
export function useSchemaLevelRunIndependence(level: string, otherwise: QualifiedIndependence | null): QualifiedIndependence | null {
  const provenance = useJudgingProvenance();
  return level === "strong" || level === "moderate" || level === "weak" ? storedSynthesisRunIndependence(provenance, true) : otherwise;
}

/** A surface that is part of a stored synthesis report (its diagnostics) but is not handed the report: the stored-synthesis run rule. */
export function useStoredSynthesisRunIndependence(): QualifiedIndependence | null {
  return storedSynthesisRunIndependence(useJudgingProvenance());
}
