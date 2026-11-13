"use client";

/**
 * generic_sections renderer (generic — the safety net schema).
 * Four sections rendered in schema order: summary, keyClaims (as an aligned
 * matrix), uncertainties, followUps. This replaces the old 12-section
 * fallback template — deliberately much smaller.
 *
 * Uncertainties/Follow-ups are raw concatenations across up to 5 models
 * (each capped at 3 items in the schema), so near-duplicate paraphrases are
 * common — a plain exact-string Set dedup left obvious repeats in. Merged
 * via the same cheap deterministic clustering shape as claim alignment
 * (textSimilarity.ts, higher similarity bar — see config.ts's
 * TEXT_DEDUP_THRESHOLDS), ranked by how many distinct models raised each
 * item, and capped (Part B6).
 */

import { ModelId } from "@/lib/types";
import { AdaptiveRendererProps } from "./types";
import { Card, SectionLabel, BulletList, FailedResultsNote, splitResults, SlotName } from "./shared";
import ClaimMatrix from "./ClaimMatrix";
import { mergeAndRankTextItems, TextItemSource } from "@/lib/adaptiveSchema/textSimilarity";
import { TEXT_DEDUP_THRESHOLDS, UNCERTAINTIES_MAX_ITEMS, FOLLOW_UPS_MAX_ITEMS } from "@/lib/adaptiveSchema/config";
import { raisedByText } from "@/lib/adaptiveSchema/verdictIndependence";
import { useJudgingProvenance } from "./useRunIndependence";

function collectTextItems(ok: AdaptiveRendererProps["results"], field: "uncertainties" | "followUps"): TextItemSource[] {
  return ok.flatMap((r) => ((r.data?.[field] as string[] | undefined) || []).map((text) => ({ modelId: r.modelId, text })));
}

export default function GenericSectionsView({ results, alignedClaims }: AdaptiveRendererProps) {
  const { ok, failed } = splitResults(results);
  const modelIds = results.map((r) => r.modelId) as ModelId[];
  const claims = alignedClaims || [];
  // c16 (MINOR-1): "(raised by N models)" counts slots; when those slots are not independent executing models (or their
  // execution is not recorded) the count is stated by panel slot with its executing models.
  const provenance = useJudgingProvenance();
  const raised = (item: { text: string; modelCount: number; modelIds: readonly string[] }) =>
    item.modelCount > 1 ? `${item.text} ${raisedByText(item.modelIds, provenance) ?? `(raised by ${item.modelCount} models)`}` : item.text;

  const uncertainties = mergeAndRankTextItems(collectTextItems(ok, "uncertainties"), {
    ...TEXT_DEDUP_THRESHOLDS,
    cap: UNCERTAINTIES_MAX_ITEMS,
  });
  const followUps = mergeAndRankTextItems(collectTextItems(ok, "followUps"), {
    ...TEXT_DEDUP_THRESHOLDS,
    cap: FOLLOW_UPS_MAX_ITEMS,
  });

  return (
    <div className="space-y-4">
      <FailedResultsNote failed={failed} />

      <Card>
        <SectionLabel>Summary</SectionLabel>
        <div className="space-y-2">
          {ok.map((r) => (
            <p key={r.modelId} className="text-sm">
              <span className="font-semibold text-slate-900"><SlotName modelId={r.modelId} />: </span>
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
          <BulletList items={uncertainties.map(raised)} />
        </Card>
      )}

      {followUps.length > 0 && (
        <Card>
          <SectionLabel>Suggested follow-ups</SectionLabel>
          <BulletList items={followUps.map(raised)} />
        </Card>
      )}
    </div>
  );
}
