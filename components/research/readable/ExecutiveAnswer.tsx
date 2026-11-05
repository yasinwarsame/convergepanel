"use client";

/**
 * #290 Increment 1 — the readable layout's answer-first section (readable mode only; classic renders
 * PrimarySynthesisStrip, unchanged).
 *
 * The heading says what the report actually holds (answerStatus.ts): "Answer" only for a written synthesis; a degraded
 * report is headed as an assembled panel summary and keeps the fixed limitation line; a report with no synthesis shows
 * no answer text at all and points to the model responses. The body is the existing answer rendering, reused unchanged
 * (UnifiedAnswerClaims / AnswerLead, so the computed vs model attribution in `data-source` is preserved), followed by the
 * same top point, key point and caveat the classic strip shows, derived with the same frozen wording functions.
 */

import { useId } from "react";
import type { AdaptiveSynthesisReport } from "@/lib/adaptiveSchema/types";
import { presentVerdictCaveat, presentVerdictClaim } from "@/lib/adaptiveSchema/agreementNarrative";
import { isPositionMarked, positionView, presentPositionSafeReport } from "@/lib/adaptiveSchema/positionPresentation";
import { AnswerLead, UnifiedAnswerClaims } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { ANALYSIS_NOTICE_LINES } from "@/components/adaptive/AnalysisAvailabilityNotice";
import { readableAnswerHasBody, readableAnswerHeading, readableAnswerStatus } from "@/lib/research/readableReport/answerStatus";
import { READABLE_ANSWER_COPY as C } from "@/lib/research/readableReport/copy";

/** The anchor ModelResponsesSection is wrapped in by the readable layout. */
export const READABLE_MODEL_RESPONSES_ANCHOR = "readable-model-responses";

export default function ExecutiveAnswer({ synthesisReport: stored }: { synthesisReport?: AdaptiveSynthesisReport | null }) {
  const headingId = useId();
  const status = readableAnswerStatus(stored);
  const heading = readableAnswerHeading(status);

  return (
    <section aria-labelledby={headingId} data-readable-tier="answer" data-answer-status={status} className="rounded-xl border border-cp-border bg-cp-surface p-4">
      <h2 id={headingId} className="text-base font-semibold text-cp-text">
        {heading}
      </h2>
      {status === "assembled" && <p className="mt-1 text-sm text-cp-muted">{ANALYSIS_NOTICE_LINES.degraded}</p>}
      {status === "unknown" && <p className="mt-1 text-sm text-cp-muted">{C.unknownNote}</p>}
      {readableAnswerHasBody(status) && stored ? (
        <AnswerBody stored={stored} />
      ) : (
        <p className="mt-2 text-sm text-cp-muted">
          {C.missingBody}{" "}
          <a href={`#${READABLE_MODEL_RESPONSES_ANCHOR}`} className="text-cp-accent underline">
            {C.missingLink}
          </a>
        </p>
      )}
    </section>
  );
}

function AnswerBody({ stored }: { stored: AdaptiveSynthesisReport }) {
  // Same handling as PrimarySynthesisStrip: a marked stored report without its rows derives no position here.
  const synthesisReport = isPositionMarked(stored) ? presentPositionSafeReport(stored, { rows: null, roster: [] }) : stored;
  const positions = positionView(synthesisReport)?.verdict ?? null;
  const { unifiedAnswer, verdictCard } = synthesisReport;
  const top = presentVerdictClaim(verdictCard.topConsensus, verdictCard.topConsensusAgreement, positions?.topLabel);
  const split = verdictCard.keyDisagreement ? presentVerdictClaim(verdictCard.keyDisagreement, verdictCard.keyDisagreementAgreement, positions?.keyLabel) : null;
  const caveat = presentVerdictCaveat(verdictCard);

  return (
    <div className="mt-2">
      {synthesisReport.presentation?.answer ? (
        <UnifiedAnswerClaims report={synthesisReport} />
      ) : (
        <>
          <AnswerLead report={synthesisReport} />
          <p className="text-sm leading-relaxed text-cp-text whitespace-pre-line">{unifiedAnswer}</p>
        </>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 border-t border-cp-border-soft pt-3 sm:grid-cols-2">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-cp-muted">{positions ? positions.topHeading : C.topPointLabel}</h3>
          <p className="mt-0.5 text-sm text-cp-text">
            {top.result ? <span data-source="model_claim">{top.claim}</span> : top.claim}
            {verdictCard.consensusModelCount > 0 && (
              <span className="text-cp-muted">{` — ${verdictCard.consensusModelCount} ${positions ? "panel slot" : "model"}${verdictCard.consensusModelCount === 1 ? "" : "s"}`}</span>
            )}
            {top.result && (
              <span data-source="computed" className="mt-0.5 block text-xs text-cp-muted">
                {top.result}
              </span>
            )}
            {verdictCard.topConsensusContested && <span className="mt-0.5 block text-xs text-amber-700">Contested: {verdictCard.topConsensusContested}</span>}
          </p>
        </div>
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-cp-muted">{positions ? positions.keyHeading : C.keyPointLabel}</h3>
          {split ? (
            <p className="mt-0.5 text-sm text-cp-text">
              {split.result ? <span data-source="model_claim">{split.claim}</span> : split.claim}
              {split.result && (
                <span data-source="computed" className="mt-0.5 block text-xs text-cp-muted">
                  {split.result}
                </span>
              )}
              {verdictCard.disagreementDetail && <span className="mt-0.5 block text-xs text-cp-muted">{verdictCard.disagreementDetail}</span>}
            </p>
          ) : (
            <p className="mt-0.5 text-sm italic text-cp-muted">{positions ? positions.noKeyText : C.noKeyPoint}</p>
          )}
        </div>
      </div>

      {caveat && (
        <p {...(verdictCard.caveatSource ? { "data-source": "model_bias" } : {})} className="mt-2 rounded-lg border border-amber-200 bg-cp-orange-soft px-2.5 py-1.5 text-xs text-amber-800">
          {caveat}
        </p>
      )}
    </div>
  );
}
