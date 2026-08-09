"use client";

/**
 * Adaptive Synthesis Report, Phase 2C-2 — a small, schema-specific callout
 * rendered between PrimarySynthesisStrip and the dedicated primary view, for
 * the two promoted schemas whose most decision-relevant fact isn't visually
 * prominent in their existing dedicated renderer:
 *
 * - legal_regulatory: `jurisdiction` is currently buried inside
 *   RuleApplicationView's per-model cards (small, muted text) — this surfaces
 *   the ALREADY-COMPUTED aligned jurisdiction claim (produced by
 *   orchestrate.ts's SCALAR_ALIGNMENT_FIELDS, the exact same mechanism
 *   DirectAnswerCard's `id === "answer"` lookup uses) so a reader can't miss
 *   which jurisdiction the analysis applies to.
 * - medical_health: `redFlags` are currently one bullet list per model card,
 *   easy to miss if a reader only skims the top model. This dedupes them
 *   across all models into one prominent list.
 *
 * Deliberately returns null for every other schema (including
 * contested_empirical) — PrimarySynthesisStrip + the unchanged dedicated
 * view already answer that schema's primary-hierarchy questions without a
 * schema-specific addition. No new computation: both branches read fields
 * the pipeline already produces, never re-score or re-derive anything.
 */

import { AdaptiveModelResult, AlignedClaim, QueryType } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel } from "./shared";

export default function SchemaKeyFactsStrip({
  schemaId,
  results,
  alignedClaims,
}: {
  schemaId: QueryType;
  results: AdaptiveModelResult[];
  alignedClaims?: AlignedClaim[];
}) {
  if (schemaId === "legal_regulatory") {
    const jurisdictionClaim = alignedClaims?.find((c) => c.id === "jurisdiction");
    const firstOkJurisdiction = results.find((r) => r.ok && typeof r.data?.["jurisdiction"] === "string")?.data?.[
      "jurisdiction"
    ] as string | undefined;
    const jurisdiction = jurisdictionClaim?.claimText || firstOkJurisdiction;
    if (!jurisdiction) return null;
    return (
      <Card className="bg-amber-50/60 border-amber-200">
        <SectionLabel>Jurisdiction</SectionLabel>
        <p className="text-sm font-semibold text-slate-900">{jurisdiction}</p>
      </Card>
    );
  }

  if (schemaId === "medical_health") {
    const redFlags = Array.from(
      new Set(
        results.flatMap((r) => (r.ok && Array.isArray(r.data?.["redFlags"]) ? (r.data!["redFlags"] as string[]) : []))
      )
    );
    if (redFlags.length === 0) return null;
    return (
      <Card className="bg-red-50/60 border-red-200">
        <SectionLabel>Red flags</SectionLabel>
        <ul className="space-y-1">
          {redFlags.map((flag, i) => (
            <li key={i} className="text-sm text-red-900">
              {flag}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  return null;
}
