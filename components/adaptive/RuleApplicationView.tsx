"use client";

/**
 * rule_application renderer (legal_regulatory).
 * Rule/jurisdiction/elements/authorities/exceptions compared per model
 * (scalar fields, no natural cross-model matrix); unsettled issues shown as
 * a claims matrix since divergence there is the interesting signal.
 */

import { ModelId } from "@/lib/types";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, PerModelCardGrid, splitResults } from "./shared";
import ClaimMatrix from "./ClaimMatrix";

export default function RuleApplicationView({ results, alignedClaims }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const modelIds = results.map((r) => r.modelId) as ModelId[];
  const claims = alignedClaims || [];

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      <PerModelCardGrid
        results={ok}
        renderBody={(data) => (
          <div className="space-y-3 text-sm">
            <div>
              <SectionLabel>Applicable rule</SectionLabel>
              <p className="text-slate-800">{data.applicableRule}</p>
              <p className="text-xs text-slate-500 mt-1">Jurisdiction: {data.jurisdiction}</p>
            </div>
            {Array.isArray(data.elements) && data.elements.length > 0 && (
              <div>
                <SectionLabel>Elements</SectionLabel>
                <ul className="space-y-1">
                  {data.elements.map((el: string, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-slate-800">
                      <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border border-slate-300" aria-hidden />
                      {el}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Array.isArray(data.keyAuthority) && data.keyAuthority.length > 0 && (
              <div>
                <SectionLabel>Key authority</SectionLabel>
                <BulletList items={data.keyAuthority} />
              </div>
            )}
            {Array.isArray(data.exceptions) && data.exceptions.length > 0 && (
              <div>
                <SectionLabel>Exceptions</SectionLabel>
                <BulletList items={data.exceptions} />
              </div>
            )}
            {Array.isArray(data.attorneyQuestions) && data.attorneyQuestions.length > 0 && (
              <div>
                <SectionLabel>Questions for a licensed attorney</SectionLabel>
                <BulletList items={data.attorneyQuestions} />
              </div>
            )}
          </div>
        )}
      />

      {claims.length > 0 && (
        <Card>
          <SectionLabel>Unsettled issues</SectionLabel>
          <ClaimMatrix claims={claims} modelIds={modelIds} />
        </Card>
      )}
    </div>
  );
}
