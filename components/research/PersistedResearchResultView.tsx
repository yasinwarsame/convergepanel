"use client";

/**
 * TEAM-RESEARCH-PARITY-R2 — LAYER 3: persisted result rendering.
 *
 * Renders ONE already-authorized, already-loaded, already-interpreted persisted
 * research result (a `PersistedResearchPresentation` from
 * `interpretPersistedRunReadPayload()`) through the SAME `ResultsDisplay` and
 * adaptive renderers the live composer uses. The Personal report page uses it
 * today; the Team report page will place its own chrome around it in R3.
 *
 * It owns exactly: the restore notice, the `ResultsDisplay` wiring, read-only
 * result behaviour, and OPTIONAL delegated actions. It performs NO fetch, NO
 * authentication, NO routing, NO Workspace/Project/assignee logic, NO review
 * mutation, and NO research execution:
 *   - `readOnlyActions` turns the execution affordances into a pointer back to
 *     the composer;
 *   - `allowSynthesisGeneration={false}` (R2 §L) guarantees the renderer never
 *     auto-POSTs `/api/synthesize-panel` — a durable read must render only the
 *     synthesis that was persisted, never create one by being opened.
 *
 * Actions are delegated, never imported: a caller that passes no
 * `onVerifyClaim` / `onRunFollowUp` gets no fabricated hand-off, which is what
 * lets Team choose different or absent actions later.
 */

import ResultsDisplay from "@/components/ResultsDisplay";
import type { PersistedResearchPresentation } from "@/lib/research/persistedRunPresentation";

export type PersistedResearchResultViewProps = {
  presentation: PersistedResearchPresentation;
  /** Delegated "Verify this claim" hand-off (Deep Research findings). Absent → no navigation is fabricated. */
  onVerifyClaim?: (args: { runId: string; claimId: string }) => void;
  /** Delegated "Run follow-up" hand-off. Absent → no navigation is fabricated. */
  onRunFollowUp?: (question: string) => void;
};

/** The execution callbacks stay required by `ResultsDisplay`'s prop contract; in read-only mode they are never invoked. */
const noExecution = () => {};

export default function PersistedResearchResultView({ presentation, onVerifyClaim, onRunFollowUp }: PersistedResearchResultViewProps) {
  return (
    <>
      {presentation.restoreNotice && (
        <p className="mt-3 rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-muted">
          {presentation.restoreNotice}
        </p>
      )}
      <div className="mt-6">
        <ResultsDisplay
          results={presentation.results}
          synthesizedReport={null}
          question={presentation.question}
          runId={presentation.runId}
          adaptive={presentation.adaptive}
          synthesisStatus={presentation.synthesisReport ? "complete" : "idle"}
          synthesisReport={presentation.synthesisReport}
          synthesisConsensusSummary={presentation.synthesisConsensusSummary as never}
          orgGovernanceStatus={presentation.orgGovernanceStatus}
          teamGovernance={presentation.governance as never}
          readOnlyActions
          allowSynthesisGeneration={false}
          onRerun={noExecution}
          onAddModel={noExecution}
          onVerifyClaim={onVerifyClaim}
          onRunFollowUp={onRunFollowUp}
        />
      </div>
    </>
  );
}
