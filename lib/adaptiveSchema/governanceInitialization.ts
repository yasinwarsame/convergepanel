/**
 * Query-Routing Redesign, Phase 2A, Step 5, Part B — governance record
 * initialization service.
 *
 * Applies only to the 9 persisted adaptive schemas already described by
 * `PersistedAdaptiveOutputV1` — no second hard-coded schema list exists
 * here; applicability is enforced by re-running `parsePersistedAdaptiveOutput`
 * on the caller's input, the SAME validator `persistedOutput.ts` already
 * exports, not a re-derived check. An ordinary, correctly-typed caller
 * (one that already has a real `PersistedAdaptiveOutputV1`, e.g. the value
 * `finalizeAdaptiveRun()` returns) should never observe `not_applicable` —
 * that status exists for a future caller that reaches this function
 * through an unsafe cast or with corrupted/absent data, not for the
 * documented happy path.
 *
 * Never calls a model, the classifier, routing, or `finalizeAdaptiveRun` —
 * this module only reshapes and persists data `finalizeAdaptiveRun` (or an
 * equivalent trusted caller) already produced. Never mutates its
 * `adaptiveOutput` input. Never throws — every code path, including
 * genuinely unexpected exceptions, resolves to a `GovernanceInitializationResult`
 * with `status: "failed"`.
 *
 * Part B intentionally implements ONLY initialization (build once, when
 * absent) — not refresh. `canRefreshDecisionReceipt`/`applyHumanReviewUpdate`
 * (Step 4, governanceRecordParser.ts) remain the only place refresh
 * semantics live; this module never rebuilds or overwrites an existing
 * valid record, reviewed or not (see the existing-record rules below).
 *
 * Not wired into any route in this step — see
 * docs/governance-decision-receipts-design.md §10 for what remains
 * unwired and why.
 */

import { logger } from "@/lib/logger";
import { persistGovernanceRecord } from "@/lib/firestore/runs";
import { parsePersistedAdaptiveOutput, PersistedAdaptiveOutputV1 } from "./persistedOutput";
import { GovernanceRecordV1 } from "./governanceRecord";
import { parseGovernanceRecord } from "./governanceRecordParser";
import { buildAdaptiveDecisionReceipt } from "./decisionReceiptBuilder";

export type GovernanceInitializationStatus =
  | "created"
  | "already_exists"
  | "blocked_reviewed"
  | "not_applicable"
  | "malformed_existing_record"
  | "unsupported_existing_version"
  | "omitted_size_limit"
  | "failed";

/**
 * `reason`, when present, is always a short, fixed, safe classifier
 * (an existing enum value from this module or one of the contracts it
 * composes) — never receipt content, source strings, question text, or a
 * raw Firestore error message.
 */
export type GovernanceInitializationResult = {
  status: GovernanceInitializationStatus;
  record?: GovernanceRecordV1;
  reason?: string;
};

function isValidTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Never throws. Builds a new `GovernanceRecordV1` and persists it only
 * when no governance record exists yet for this run. An existing record —
 * whatever its review state — is always preserved as-is; this function
 * never rebuilds or overwrites one, reviewed or not (Objective #4).
 */
export async function initializeAdaptiveGovernanceRecord(args: {
  runId: string;
  adaptiveOutput: PersistedAdaptiveOutputV1;
  existingGovernanceRecord?: unknown;
  now?: string;
}): Promise<GovernanceInitializationResult> {
  try {
    const { runId, adaptiveOutput, existingGovernanceRecord } = args;

    if (typeof runId !== "string" || runId.trim().length === 0) {
      return { status: "failed", reason: "invalid_run_id" };
    }

    const now = args.now ?? new Date().toISOString();
    if (typeof now !== "string" || !isValidTimestamp(now)) {
      return { status: "failed", reason: "invalid_timestamp" };
    }

    // Applicability: reuse persistedOutput.ts's own validator rather than a
    // second hard-coded schema/version check. A normally-typed caller
    // always passes this; this guards the unsafe-cast case only.
    const parsedOutput = parsePersistedAdaptiveOutput(adaptiveOutput);
    if (!parsedOutput.ok) {
      return { status: "not_applicable", reason: `adaptive_output_${parsedOutput.reason}` };
    }

    const existing = parseGovernanceRecord(existingGovernanceRecord);

    if (!existing.ok) {
      if (existing.reason === "malformed") {
        return { status: "malformed_existing_record", reason: "malformed" };
      }
      if (existing.reason === "unsupported_version") {
        return { status: "unsupported_existing_version", reason: "unsupported_version" };
      }
      // "absent" — fall through and create.
    } else {
      const status = existing.record.humanReview.status;
      if (status === "unreviewed" || status === "pending") {
        return { status: "already_exists", record: existing.record, reason: status };
      }
      // approved | approved_with_conditions | changes_requested | rejected
      return { status: "blocked_reviewed", record: existing.record, reason: status };
    }

    // Absent — build and persist a new record. buildAdaptiveDecisionReceipt
    // is invoked exactly once, only on this path (Objective #5).
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

    const outcome = await persistGovernanceRecord(runId, record);
    if (outcome.saved) {
      return { status: "created", record };
    }
    if (outcome.reason === "oversized") {
      return { status: "omitted_size_limit", record, reason: "oversized" };
    }
    // "firestore_unavailable" | "write_failed"
    return { status: "failed", record, reason: outcome.reason };
  } catch (err: unknown) {
    logger.error("[governanceInitialization] Unexpected error during initialization", {
      runId: args?.runId,
      schemaId: (args?.adaptiveOutput as { schemaId?: unknown } | undefined)?.schemaId,
      status: "failed",
    });
    return { status: "failed", reason: "unexpected_error" };
  }
}
