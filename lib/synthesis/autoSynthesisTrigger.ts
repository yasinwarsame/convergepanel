/**
 * TEAM-RESEARCH-PARITY-R2 §L — the ONE decision for whether `ResultsDisplay`
 * may automatically start structured synthesis (`POST /api/synthesize-panel`)
 * for the run it is showing.
 *
 * Pure and client-safe so the policy is testable without mounting the
 * 2,300-line renderer. The first six conditions are the pre-existing
 * auto-trigger rule, unchanged: at least two successful rows, a run id to
 * cache against, not already triggered for that id, synthesis still idle, no
 * pre-generated report, no adaptive result. The seventh,
 * `allowSynthesisGeneration`, is the R2 addition: a durable READ surface (the
 * Personal report page today, the Team report page in R3) passes `false`, and
 * then NOTHING here can return `true` — opening a saved report must never
 * write a synthesis merely because it was opened. The live composer never
 * passes it, so it stays `true` there and behaviour is unchanged.
 */
export type AutoSynthesisTriggerInput = {
  okResultCount: number;
  runId: string | null | undefined;
  alreadyTriggered: boolean;
  synthesisStatus: "idle" | "loading" | "complete" | "error";
  hasPreGeneratedReport: boolean;
  hasAdaptive: boolean;
  allowSynthesisGeneration: boolean;
};

export function shouldAutoTriggerSynthesis(input: AutoSynthesisTriggerInput): boolean {
  if (!input.allowSynthesisGeneration) return false;
  if (input.okResultCount < 2) return false;
  if (!input.runId) return false;
  if (input.alreadyTriggered) return false;
  if (input.synthesisStatus !== "idle") return false;
  if (input.hasPreGeneratedReport) return false;
  if (input.hasAdaptive) return false;
  return true;
}
