/**
 * ADD-TO-TEAM-PROJECT §M — the PURE, zero-I/O half of governance record
 * initialization, extracted narrowly from
 * `governanceInitialization.ts`'s `initializeAdaptiveGovernanceRecord()`.
 *
 * Why this exists as its own module: `initializeAdaptiveGovernanceRecord()`
 * both BUILDS a fresh `GovernanceRecordV1` and PERSISTS it through
 * `persistGovernanceRecord()` — a `.set(..., {merge:true})` writer that runs
 * after the run document already exists. A Team snapshot created from a
 * Personal run must carry its fresh governance record INSIDE the same
 * `tx.create()` as the run itself (a second, post-commit merge write would
 * be best-effort secondary state — the exact pattern the Phase 4C
 * provenance audit forbids for anything that must be provably present).
 * So the build step has to be callable without the persistence step.
 *
 * This module imports nothing from the Firestore layer — no database
 * handle, no writer — so it can never touch Firestore. `initializeAdaptiveGovernanceRecord()`
 * keeps its existing external behavior byte-for-byte (same validation
 * order, same statuses, same reasons, receipt built exactly once and only
 * on the absent-record path) and now delegates the record construction
 * here; the parity suite `governanceRecordBuilderParity.spec.ts` proves the
 * two produce identical records for identical inputs.
 *
 * Never mutates `adaptiveOutput`. Never calls a model, the classifier,
 * routing, or any persistence. Never throws on ordinary inputs — invalid
 * inputs resolve to a typed failure.
 */

import { parsePersistedAdaptiveOutput, type PersistedAdaptiveOutputV1 } from "./persistedOutput";
import type { GovernanceRecordV1 } from "./governanceRecord";
import { buildAdaptiveDecisionReceipt } from "./decisionReceiptBuilder";

export type BuildAdaptiveGovernanceRecordResult =
  | { ok: true; record: GovernanceRecordV1 }
  | { ok: false; status: "failed"; reason: "invalid_run_id" | "invalid_timestamp" }
  | { ok: false; status: "not_applicable"; reason: string };

export function isValidGovernanceTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Builds the SAME record `initializeAdaptiveGovernanceRecord()` builds on
 * its absent-record path: `humanReview.status = "unreviewed"`, a decision
 * receipt derived once from the parsed adaptive output, and
 * `createdAt === updatedAt === now`. `now` is REQUIRED here (never
 * defaulted) so a caller embedding this record in a transaction can pin it
 * to the exact same instant as the run's own timestamps.
 */
export function buildAdaptiveGovernanceRecord(args: {
  runId: string;
  adaptiveOutput: PersistedAdaptiveOutputV1;
  now: string;
}): BuildAdaptiveGovernanceRecordResult {
  const { runId, adaptiveOutput, now } = args;

  if (typeof runId !== "string" || runId.trim().length === 0) {
    return { ok: false, status: "failed", reason: "invalid_run_id" };
  }
  if (typeof now !== "string" || !isValidGovernanceTimestamp(now)) {
    return { ok: false, status: "failed", reason: "invalid_timestamp" };
  }

  // Applicability: reuse persistedOutput.ts's own validator rather than a
  // second hard-coded schema/version check — identical to the initializer.
  const parsedOutput = parsePersistedAdaptiveOutput(adaptiveOutput);
  if (!parsedOutput.ok) {
    return { ok: false, status: "not_applicable", reason: `adaptive_output_${parsedOutput.reason}` };
  }

  const receipt = buildAdaptiveDecisionReceipt(parsedOutput.output);
  const record: GovernanceRecordV1 = {
    version: 1,
    schemaId: parsedOutput.output.schemaId,
    answerShape: parsedOutput.output.answerShape,
    adaptiveOutputVersion: parsedOutput.output.version,
    humanReview: { status: "unreviewed" },
    decisionReceipt: receipt,
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, record };
}
