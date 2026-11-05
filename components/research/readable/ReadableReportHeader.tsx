"use client";

/**
 * #290 Increment 1 — the readable layout's lead: the answer first, then the four trust signals. Rendered by
 * AdaptivePanelResponse in place of PrimarySynthesisStrip, in readable mode and for the Phase 2 pilot schemas only;
 * everything after it (schema facts, the schema's own view, Model Responses, Panel Evidence, Review & Governance) is
 * the classic content, unchanged and still fully present.
 */

import type { AdaptiveGateResult, AdaptiveModelResult, AdaptiveSynthesisReport, AdaptiveTrustSummary, AlignedClaim, ResultSchema } from "@/lib/adaptiveSchema/types";
import ExecutiveAnswer from "./ExecutiveAnswer";
import TrustSignalsPanel from "./TrustSignalsPanel";

export interface ReadableReportHeaderProps {
  schema: Pick<ResultSchema, "id" | "fields">;
  results: AdaptiveModelResult[];
  alignedClaims?: AlignedClaim[];
  gate?: AdaptiveGateResult;
  synthesisReport?: AdaptiveSynthesisReport;
  trustSummary?: AdaptiveTrustSummary;
}

export default function ReadableReportHeader(props: ReadableReportHeaderProps) {
  return (
    <>
      <ExecutiveAnswer synthesisReport={props.synthesisReport} />
      <TrustSignalsPanel {...props} />
    </>
  );
}
