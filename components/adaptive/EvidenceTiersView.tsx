"use client";

/**
 * evidence_tiers renderer (medical_health).
 * Aligned claims grouped by evidenceType, strongest tier first.
 */

import { ModelId } from "@/lib/types";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, PerModelCardGrid, splitResults } from "./shared";
import ClaimMatrix from "./ClaimMatrix";

const TIER_ORDER = ["empirical", "authoritative", "theoretical", "anecdotal"] as const;
const TIER_LABEL: Record<string, string> = {
  empirical: "Empirical (RCT / meta-analysis)",
  authoritative: "Authoritative (clinical guidelines)",
  theoretical: "Observational / mechanistic",
  anecdotal: "Anecdotal",
};

export default function EvidenceTiersView({ results, alignedClaims }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const modelIds = results.map((r) => r.modelId) as ModelId[];
  const claims = alignedClaims || [];

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      {claims.length > 0 ? (
        <Card>
          <SectionLabel>Evidence by tier</SectionLabel>
          <div className="space-y-5">
            {TIER_ORDER.map((tier) => {
              const tierClaimIds = new Set(
                ok.flatMap((r) => ((r.data?.evidenceByTier as any[] | undefined) || []).filter((c) => c.evidenceType === tier).map((c) => c.id))
              );
              const tierClaims = claims.filter((c) => tierClaimIds.has(c.id));
              if (tierClaims.length === 0) return null;
              return (
                <div key={tier}>
                  <h5 className="text-sm font-semibold text-slate-700 mb-2">{TIER_LABEL[tier]}</h5>
                  <ClaimMatrix claims={tierClaims} modelIds={modelIds} />
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <p className="text-sm text-slate-500">No evidence claims to compare.</p>
      )}

      <PerModelCardGrid
        results={ok}
        renderBody={(data) => (
          <div className="space-y-2 text-sm">
            <p className="text-slate-800">{data.summary}</p>
            <p className="text-slate-600 text-xs">{data.mechanism}</p>
            {Array.isArray(data.guidelinePositions) && data.guidelinePositions.length > 0 && (
              <div>
                <SectionLabel>Guideline positions</SectionLabel>
                <BulletList items={data.guidelinePositions} />
              </div>
            )}
            {Array.isArray(data.redFlags) && data.redFlags.length > 0 && (
              <div>
                <SectionLabel>Red flags</SectionLabel>
                <BulletList items={data.redFlags} />
              </div>
            )}
            {Array.isArray(data.clinicianQuestions) && data.clinicianQuestions.length > 0 && (
              <div>
                <SectionLabel>Questions for a licensed clinician</SectionLabel>
                <BulletList items={data.clinicianQuestions} />
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}
