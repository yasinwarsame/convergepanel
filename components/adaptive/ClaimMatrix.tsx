"use client";

/**
 * Claims × models matrix — the shared visualization behind consensus_map,
 * rule_application's unsettled issues, evidence_tiers, and generic_sections.
 * Each row is one AlignedClaim (Phase 4b output); each column is a model.
 */

import { Fragment, useState } from "react";
import { ModelId } from "@/lib/types";
import { AlignedClaim, ClaimCellStance } from "@/lib/adaptiveSchema/types";
import { getModelLabel } from "./shared";

const STANCE_STYLES: Record<ClaimCellStance, { label: string; className: string }> = {
  agrees: { label: "Agrees", className: "bg-green-50 text-green-700 border-green-200" },
  disputes: { label: "Disputes", className: "bg-orange-50 text-orange-700 border-orange-200" },
  partial: { label: "Partial", className: "bg-amber-50 text-amber-700 border-amber-200" },
  unclear: { label: "Unclear", className: "bg-blue-50 text-blue-700 border-blue-200" },
};

function StanceChip({ stance }: { stance: ClaimCellStance }) {
  const style = STANCE_STYLES[stance];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}

export default function ClaimMatrix({
  claims,
  modelIds,
}: {
  claims: AlignedClaim[];
  modelIds: ModelId[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (claims.length === 0) {
    return <p className="text-sm text-slate-500">No claims to compare.</p>;
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-slate-200">
            <th className="text-left font-semibold text-slate-600 py-2 pr-4">Claim</th>
            {modelIds.map((modelId) => (
              <th key={modelId} className="text-left font-semibold text-slate-600 py-2 px-2 whitespace-nowrap">
                {getModelLabel(modelId)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => {
            const hasCamps = claim.cells.some((c) => c && c.camps && c.camps.length > 0);
            const hasPositions = claim.cells.some((c) => !!c);
            const isExpanded = expanded.has(claim.id);
            return (
              <Fragment key={claim.id}>
                <tr className="border-b border-slate-100 align-top">
                  <td className="py-3 pr-4 text-slate-900">
                    {claim.claimText}
                    {hasPositions && (
                      <button
                        type="button"
                        onClick={() => toggle(claim.id)}
                        className="ml-2 text-xs font-medium text-sky-600 hover:underline"
                      >
                        {isExpanded ? "Hide positions" : "Show positions"}
                      </button>
                    )}
                  </td>
                  {claim.cells.map((cell, idx) => (
                    <td key={modelIds[idx]} className="py-3 px-2">
                      {cell ? <StanceChip stance={cell.stance} /> : <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                </tr>
                {isExpanded && hasPositions && (
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <td colSpan={modelIds.length + 1} className="py-3 px-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {claim.cells
                          .map((cell, idx) => (cell ? { cell, modelId: modelIds[idx] } : null))
                          .filter((entry): entry is { cell: NonNullable<typeof claim.cells[number]>; modelId: ModelId } => !!entry)
                          .map(({ cell, modelId }) => (
                            <div key={modelId} className="text-xs text-slate-700">
                              <span className="font-semibold text-slate-900">{getModelLabel(modelId)}: </span>
                              {cell.excerpt}
                              {cell.backfilled && <span className="ml-1 text-slate-400">(inferred)</span>}
                            </div>
                          ))}
                        {hasCamps &&
                          claim.cells
                            .filter((c): c is NonNullable<typeof c> => !!c && !!c.camps && c.camps.length > 0)
                            .flatMap((c) => c.camps!)
                            .map((camp, i) => (
                              <div key={`camp-${i}`} className="text-xs text-slate-700">
                                <span className="font-semibold text-slate-900">{camp.label}: </span>
                                {camp.position}
                              </div>
                            ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
