"use client";

/**
 * Query-Routing Redesign, Milestone 1.
 *
 * Lightweight renderer for factual_lookup — one short verifiable answer
 * shouldn't be wrapped in the full synthesis-report shell (Trust Summary,
 * Agreement/Disagreement Map, Panel Verdict Card, export actions, etc).
 * This is a RENDERING change only: factual_lookup's fields, prompt, parser,
 * alignment, and verification are all untouched — this component reads the
 * exact same `results`/`alignedClaims`/`gate` shapes every other adaptive
 * renderer reads, it just presents them compactly.
 *
 * Answer, source, and caveat come straight from factualLookupFields
 * (schemaRegistry.ts) — no new fields were added for this component.
 */

import { AdaptiveGateResult, AdaptiveModelResult, AlignedClaim } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel, FailedResultsNote, ProbabilityBar, getModelLabel, splitResults } from "./shared";
import ModelChip from "@/components/ModelChip";

function agreementColorClass(score: number): string {
  if (score >= 0.7) return "bg-green-500";
  if (score >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

export default function DirectAnswerCard({
  results,
  alignedClaims,
  gate,
}: {
  results: AdaptiveModelResult[];
  alignedClaims?: AlignedClaim[];
  gate?: AdaptiveGateResult;
}) {
  const { ok, failed } = splitResults(results);

  // factual_lookup's "answer" field is scalar-aligned (SCALAR_ALIGNMENT_FIELDS
  // in orchestrate.ts) into a single AlignedClaim row when verification is
  // enabled — that row's claimText is the canonical, cross-model-checked
  // answer. Fall back to the first successful model's own answer otherwise
  // (verification engine off, or no aligned row for any reason).
  const answerRow = alignedClaims?.find((c) => c.id === "answer");
  const headlineAnswer = answerRow?.claimText || (ok[0]?.data?.["answer"] as string | undefined) || "No answer returned.";

  return (
    <div className="space-y-3">
      <FailedResultsNote failed={failed} />

      <Card className="bg-sky-50/60 border-sky-200">
        <SectionLabel>Answer</SectionLabel>
        <p className="text-base leading-relaxed text-slate-900 font-medium whitespace-pre-line">{headlineAnswer}</p>

        {gate && (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1">
              <ProbabilityBar probability={gate.runCertainty} colorClass={agreementColorClass(gate.runCertainty)} />
            </div>
            <span className="text-xs font-medium text-slate-600 whitespace-nowrap">
              {Math.round(gate.runCertainty * 100)}% certainty
            </span>
          </div>
        )}
      </Card>

      {ok.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Model-by-model answers ({ok.length})
          </summary>
          <div className="mt-3 space-y-3">
            {ok.map((r) => {
              const source = r.data?.["source"] as string | undefined;
              const caveat = r.data?.["caveat"] as string | undefined;
              return (
                <div key={r.modelId} className="flex items-start gap-2 text-sm">
                  <ModelChip modelId={r.modelId} size="xs" className="mt-0.5 shrink-0" />
                  <div>
                    <p className="text-slate-800">{(r.data?.["answer"] as string) ?? "—"}</p>
                    {source && source.toLowerCase() !== "unknown" && (
                      <p className="text-xs text-slate-500 mt-0.5">Source: {source}</p>
                    )}
                    {caveat && caveat.toLowerCase() !== "none" && (
                      <p className="text-xs text-amber-700 mt-0.5">{caveat}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
