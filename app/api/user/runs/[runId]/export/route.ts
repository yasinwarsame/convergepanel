/**
 * Adaptive Research Export — POST /api/user/runs/[runId]/export.
 * `format: "pdf"` (Phase 1, always accepted), `format: "docx"` (Phase 3,
 * accepted only while `ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED` is on), or
 * `format: "json"` (Phase 4, accepted only while
 * `ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED` is on — see each flag's own doc
 * comment in lib/env.ts). CSV still rejected — out of scope for this phase
 * too. Route organization mirrors the existing `GET /api/user/runs/[runId]`
 * convention (same auth pattern, same run-ownership check).
 *
 * Flow (Part 12): authenticate → load run → authorize access to run →
 * check ADAPTIVE_RESEARCH_EXPORT_ENABLED → validate the requested format
 * → verify plan/role/governance eligibility (canExportAdaptiveResearch,
 * format-independent) → freeze report snapshot → create versioned export
 * artifact ("generating") → render the requested format → persist
 * artifact metadata ("ready") → supersede older exports → record audit
 * event → stream the file back directly (no separate download step — the
 * storage decision means the bytes are never durably stored, see
 * researchExport.ts's header comment — true for DOCX exactly as it was
 * for PDF).
 *
 * Failure semantics (Part 19): the export record is created BEFORE
 * rendering is attempted, in "generating" state. If rendering throws, the
 * record is marked "failed" with a reason, a failure audit event is
 * recorded, and the response is a clean error — never a partial/corrupt
 * download. The record is never marked "ready" until the file's bytes
 * were genuinely produced.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED, ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED, ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED } from "@/lib/env";
import { parsePersistedAdaptiveOutput, parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { resolveAdaptiveExportVerdict } from "@/lib/adaptiveSchema/exportAuthorization";
import { resolveExportGeneratedBy } from "@/lib/adaptiveSchema/exportGeneratedBy";
import { AdaptiveResearchExportV1, AdaptiveExportFormat, adaptiveExportContentType, adaptiveExportFileExtension } from "@/lib/adaptiveSchema/researchExport";
import { createAdaptiveExportRecord, markAdaptiveExportReady, markAdaptiveExportFailed, supersedeOlderAdaptiveExports } from "@/lib/firestore/adaptiveExports";
import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { writeAdaptiveExportAdminAuditEvent } from "@/lib/governance/auditLog";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";
import type { ModelId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/user/runs/[runId]/export", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function errorResponse(status: number, errorCode: string, message: string) {
  return NextResponse.json({ ok: false, errorCode, message }, { status });
}

export async function POST(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!ADAPTIVE_RESEARCH_EXPORT_ENABLED) {
    return errorResponse(404, "not_found", "Not found.");
  }

  const { runId } = await context.params;
  if (!runId?.trim() || !adminDb) {
    return errorResponse(404, "not_found", "Run not found.");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be valid JSON.");
  }
  const format = (body as { format?: unknown })?.format;
  // DOCX (Phase 3) and JSON (Phase 4) each sit behind their OWN release
  // flag, checked here rather than folded into the format-validity check
  // below — a request for a not-yet-enabled format must be rejected the
  // same way an unrecognized format string would be (never a
  // flag-specific error message that would reveal the feature exists but
  // is disabled).
  const validFormats: AdaptiveExportFormat[] = ["pdf"];
  if (ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED) validFormats.push("docx");
  if (ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED) validFormats.push("json");
  if (typeof format !== "string" || !validFormats.includes(format as AdaptiveExportFormat)) {
    return errorResponse(400, "unsupported_format", `Only format: ${validFormats.map((f) => `"${f}"`).join(" or ")} is supported.`);
  }
  const validatedFormat: AdaptiveExportFormat = format as AdaptiveExportFormat;

  // ── Load run + authorize access (mirrors GET /api/user/runs/[runId]) ──
  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }
  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");

  // Phase 4B — Mandatory Workspace Integrity, requester-independent, before
  // the owner check and before any export generation.
  const integrity = await validateRunWorkspaceAssociation(data);
  if (integrity.classification === "invalid") {
    logger.warn("[user/runs/export] workspace_run_integrity_failed", { runId, reason: integrity.reason });
    return errorResponse(404, "not_found", "Run not found.");
  }

  if (owner !== uid) {
    return errorResponse(403, "forbidden", "You do not have access to this run.");
  }

  const question = String(data.question ?? "");
  const selectedModels = (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[];

  const parsedAdaptive = parsePersistedAdaptiveOutput(data.adaptiveOutput);
  const parsedLegacy = parsePersistedLegacyAdaptiveOutput(data.legacyAdaptiveOutput);

  // ── Build the frozen snapshot (schema-family-aware) ──
  let snapshotResult: ReturnType<typeof buildExportSnapshot>;
  let schemaId: string;
  let schemaFamily: "milestone2" | "legacy";

  if (parsedAdaptive.ok) {
    const parsedGovernance = parseGovernanceRecord(data.governanceRecord);
    snapshotResult = buildExportSnapshot({
      question,
      selectedModels,
      milestone2: {
        output: parsedAdaptive.output,
        governanceRecord: parsedGovernance.ok ? parsedGovernance.record : undefined,
        // History-style export (not a live in-flight run) never re-derives
        // team-projection routing — matches GET /api/user/runs/[runId]'s
        // own "unknown" default for a reload context; deriveReportStatus
        // treats "unknown" identically to "in_queue" (fails closed toward
        // "still needs attention"), never a false "no review configured".
        reviewRouting: "unknown",
      },
    });
    schemaId = parsedAdaptive.output.schemaId;
    schemaFamily = "milestone2";
  } else if (parsedLegacy.ok) {
    const rawGovStatus = data.governanceStatus;
    const governanceStatus = rawGovStatus === "approved" || rawGovStatus === "needs_review" || rawGovStatus === "blocked" ? rawGovStatus : null;
    snapshotResult = buildExportSnapshot({
      question,
      selectedModels,
      legacy: { output: parsedLegacy.output, governanceStatus },
    });
    schemaId = parsedLegacy.output.schemaId;
    schemaFamily = "legacy";
  } else {
    return errorResponse(422, "no_report", "This run has no adaptive research report to export.");
  }

  const { reportSnapshot, governanceStatusAtExport, classification } = snapshotResult;

  // ── Authorization (Part 5) — single central function, re-checked here regardless of what the UI showed ──
  const verdict = await resolveAdaptiveExportVerdict(uid, owner, classification, governanceStatusAtExport);
  if (!verdict.allowed) {
    return errorResponse(403, verdict.reason, "You are not permitted to export this report.");
  }

  // ── Create the export record ("generating") ──
  const exportId = `exp-${randomUUID()}`;
  const nowIso = new Date().toISOString();

  // Export Generator Provenance — resolved and frozen HERE, at creation
  // time only, from the already-authenticated `uid` (never from the
  // request body). Regeneration (GET /api/user/runs/[runId]/exports/[exportId])
  // never calls this — it renders `generatedBy` straight off the record
  // read back from Firestore. See exportGeneratedBy.ts's header comment
  // for the full historical-invariant rationale.
  const generatedBy = await resolveExportGeneratedBy(uid);

  const recordBase: Omit<AdaptiveResearchExportV1, "reportVersion" | "exportMetadata"> & {
    exportMetadata: Omit<AdaptiveResearchExportV1["exportMetadata"], "finalReportVersion">;
  } = {
    version: 1,
    exportId,
    runId,
    schemaId: schemaId as AdaptiveResearchExportV1["schemaId"],
    schemaFamily,
    schemaVersion: 1,
    createdAt: nowIso,
    createdBy: uid,
    generatedBy,
    format: validatedFormat,
    artifactStatus: "generating",
    classification,
    governanceStatusAtExport,
    reportSnapshot,
    exportMetadata: {
      exportId,
      runId,
      schemaVersion: 1,
      exportedSections: schemaFamily === "milestone2" ? ["reportSnapshot.milestone2"] : ["reportSnapshot.legacy"],
      createdAt: nowIso,
      requestingUser: uid,
    },
  };

  const createResult = await createAdaptiveExportRecord({ runId, exportId, record: recordBase });
  if (!createResult.ok) {
    return errorResponse(500, "export_create_failed", "Could not start export generation. Please try again.");
  }
  const reportVersion = createResult.reportVersion;

  // ── Generate the file (deterministic, pure function of the frozen snapshot) ──
  const fullRecord: AdaptiveResearchExportV1 = {
    ...recordBase,
    reportVersion,
    exportMetadata: { ...recordBase.exportMetadata, finalReportVersion: reportVersion },
  };

  // Only rendering itself is "the operation that can genuinely fail" here
  // — the narrowest possible try/catch. markAdaptiveExportReady,
  // supersedeOlderAdaptiveExports, and the audit write are all
  // post-generation bookkeeping around an ALREADY-successful export; none
  // of them may ever cause a successful export to be reported to the
  // client as failed, and a transient failure in any of them must not
  // rewrite the canonical record from "ready" back to "failed" (final
  // review Step 17 — this used to sit inside the same try/catch as
  // rendering, which would have misclassified a successful export as
  // failed had any of those calls ever thrown; they don't today because
  // each already swallows its own errors into a result object, but the
  // control flow itself should not have depended on that implementation
  // detail).
  let bytes: Buffer;
  let sha256: string;
  const renderStartedAt = Date.now();
  try {
    const rendered = await renderAdaptiveResearchExport(fullRecord);
    bytes = rendered.bytes;
    sha256 = rendered.sha256;
  } catch (err: unknown) {
    const failureReason = err instanceof Error ? err.message : "unknown_error";
    logger.error("[adaptive-export] export generation failed", { runId, exportId, format: validatedFormat, errorMessage: failureReason });

    await markAdaptiveExportFailed(runId, exportId, failureReason);
    await writeAdaptiveExportAdminAuditEvent({
      exportId,
      action: "adaptive_export_generation_failed",
      actorUid: uid,
      runId,
      schemaId,
      schemaFamily,
      classification,
      format: validatedFormat,
      reportVersion,
      governanceStatusAtExport: governanceStatusAtExport.family === "milestone2" ? governanceStatusAtExport.kind : `legacy:${governanceStatusAtExport.status ?? "not_evaluated"}`,
      at: new Date().toISOString(),
      failureReason,
      durationMs: Date.now() - renderStartedAt,
    });

    return errorResponse(500, "export_generation_failed", "Export generation failed. Please try again.");
  }
  const renderDurationMs = Date.now() - renderStartedAt;

  // The file genuinely exists at this point. Everything below is
  // best-effort bookkeeping around an already-successful export. All three
  // helpers already swallow their own errors into a result object today
  // (never throwing), but this block does not rely on that — it's wrapped
  // defensively so that even a future regression in one of them can never
  // propagate into the response the client receives below.
  try {
    const readyResult = await markAdaptiveExportReady(runId, exportId, sha256);
    if (!readyResult.ok) {
      logger.error("[adaptive-export] failed to mark export ready after successful generation", { runId, exportId, reason: readyResult.reason });
    }

    const supersedeResult = await supersedeOlderAdaptiveExports(runId, exportId);
    if (!supersedeResult.ok) {
      logger.error("[adaptive-export] failed to supersede older exports", { runId, exportId, reason: supersedeResult.reason });
    }

    await writeAdaptiveExportAdminAuditEvent({
      exportId,
      action: "adaptive_export_generated",
      actorUid: uid,
      runId,
      schemaId,
      schemaFamily,
      classification,
      format: validatedFormat,
      reportVersion,
      governanceStatusAtExport: governanceStatusAtExport.family === "milestone2" ? governanceStatusAtExport.kind : `legacy:${governanceStatusAtExport.status ?? "not_evaluated"}`,
      at: nowIso,
      durationMs: renderDurationMs,
      byteSize: bytes.length,
    });
  } catch (bookkeepingErr: unknown) {
    // A successful export must never be reported as failed to the client
    // because of a problem in post-generation bookkeeping — log and move on.
    logger.error("[adaptive-export] post-generation bookkeeping failed (export itself still succeeded)", {
      runId,
      exportId,
      errorMessage: bookkeepingErr instanceof Error ? bookkeepingErr.message : "unknown_error",
    });
  }

  const fileName = `convergepanel-export-${runId}-v${reportVersion}.${adaptiveExportFileExtension(validatedFormat)}`;
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": adaptiveExportContentType(validatedFormat),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(bytes.length),
    },
  });
}
