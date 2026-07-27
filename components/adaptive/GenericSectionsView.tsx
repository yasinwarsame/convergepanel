"use client";

/**
 * generic_sections renderer (generic — the safety net schema).
 * Four sections rendered in schema order: summary, keyClaims (as an aligned
 * matrix), uncertainties, followUps. This replaces the old 12-section
 * fallback template — deliberately much smaller.
 */

import { ModelId } from "@/lib/types";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, splitResults, getModelLabel } from "./shared";
import ClaimMatrix from "./ClaimMatrix";

export default function GenericSectionsView({ results, alignedClaims }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const modelIds = results.map((r) => r.modelId) as ModelId[];
  const claims = alignedClaims || [];

  const uncertainties = Array.from(new Set(ok.flatMap((r) => (r.data?.uncertainties as string[] | undefined) || [])));
  const followUps = Array.from(new Set(ok.flatMap((r) => (r.data?.followUps as string[] | undefined) || [])));

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      <Card>
        <SectionLabel>Summary</SectionLabel>
        <div className="space-y-2">
          {ok.map((r) => (
            <p key={r.modelId} className="text-sm">
              <span className="font-semibold text-slate-900">{getModelLabel(r.modelId)}: </span>
              <span className="text-slate-700">{r.data?.summary as string}</span>
            </p>
          ))}
        </div>
      </Card>

      {claims.length > 0 && (
        <Card>
          <SectionLabel>Key claims</SectionLabel>
          <ClaimMatrix claims={claims} modelIds={modelIds} />
        </Card>
      )}

      {uncertainties.length > 0 && (
        <Card>
          <SectionLabel>Uncertainties</SectionLabel>
          <BulletList items={uncertainties} />
        </Card>
      )}

      {followUps.length > 0 && (
        <Card>
          <SectionLabel>Suggested follow-ups</SectionLabel>
          <BulletList items={followUps} />
        </Card>
      )}
    </div>
  );
}
