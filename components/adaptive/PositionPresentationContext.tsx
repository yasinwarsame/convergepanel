"use client";

/**
 * Order 5 (Contract P): whether the report on this page is marked for the disagreement-position presentation, with
 * the dispatched roster and recorded slot provenance the row-level surfaces (agreement map, claim matrix, list view,
 * load-bearing claims) need to state positions from the stored rows. Provided once, by AdaptivePanelResponse.
 *
 * `null` (the default) means the historical presentation: a surface outside the provider renders exactly as before.
 */

import { createContext, createElement, useContext, type ReactNode } from "react";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { isPositionMarked } from "@/lib/adaptiveSchema/positionPresentation";
import { RunModelProvenanceContext } from "./RunModelProvenanceContext";

export interface PositionPresentationState {
  marked: true;
  roster: readonly string[];
  provenance: readonly RunModelProvenanceFacts[] | null;
}

export const PositionPresentationContext = createContext<PositionPresentationState | null>(null);

export function usePositionPresentation(): PositionPresentationState | null {
  return useContext(PositionPresentationContext);
}

/**
 * For a surface that can be rendered on its own (the report view, the list view, panel evidence, the governance body):
 * when its report is marked and no AdaptivePanelResponse above it provided the context, provide it here, so its
 * row-level children state positions the same way. Otherwise renders its children unchanged.
 */
export function PositionPresentationBoundary({ report, roster, provenance, children }: { report: unknown; roster: readonly string[]; provenance?: readonly RunModelProvenanceFacts[] | null; children: ReactNode }) {
  const existing = useContext(PositionPresentationContext);
  // Without explicit provenance, the page's recorded per-slot provenance (RunModelProvenanceContext) names the slots —
  // so a substituted slot is never named without its substitution on a standalone surface.
  const pageProvenance = useContext(RunModelProvenanceContext);
  if (existing || !isPositionMarked(report)) return createElement(PositionPresentationContextFragment, null, children);
  return createElement(PositionPresentationContext.Provider, { value: { marked: true, roster, provenance: provenance ?? pageProvenance ?? null } }, children);
}

function PositionPresentationContextFragment({ children }: { children?: ReactNode }) {
  return children as JSX.Element;
}
