/**
 * Adaptive Research Export, Phase 1 — POST /api/user/runs/[runId]/export.
 * PDF only (`format: "pdf"`); DOCX/JSON/CSV rejected. Route organization
 * mirrors the existing `GET /api/user/runs/[runId]` convention (same auth
 * pattern, same run-ownership check).
 *
 * Flow (Part 12): authenticate → load run → authorize access to run →
 * check ADAPTIVE_RESEARCH_EXPORT_ENABLED → verify plan/role/governance
 * eligibility (canExportAdaptiveResearch) → freeze report snapshot →
 * create versioned export artifact ("generating") → generate PDF →
 * persist artifact metadata ("ready") → supersede older exports → record
 * audit event → stream the PDF back directly (no separate download step —
 * Phase 1's storage decision means the bytes are never durably stored, see
 * researchExport.ts's header comment).
 *
 * Failure semantics (Part 19): the export record is created BEFORE PDF
 * generation is attempted, in "generating" state. If PDF generation throws,
 * the record is marked "failed" with a reason, a failure audit event is
 * recorded, and the response is a clean error — never a partial/corrupt
 * download. The record is never marked "ready" until the PDF bytes were
 * genuinely produced.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED } from "@/lib/env";
import { parsePersistedAdaptiveOutput, parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { resolveAdaptiveExportVerdict } from "@/lib/adaptiveSchema/exportAuthorization";
import { AdaptiveResearchExportV1, AdaptiveExportFormat } from "@/lib/adaptiveSchema/researchExport";
import { createAdaptiveExportRecord, markAdaptiveExportReady, markAdaptiveExportFailed, supersedeOlderAdaptiveExports } from "@/lib/firestore/adaptiveExports";
import { renderAdaptiveResearchPdf } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { writeAdaptiveExportAdminAuditEvent } from "@/lib/governance/auditLog";
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
  if (format !== "pdf") {
    return errorResponse(400, "unsupported_format", "Only format: \"pdf\" is supported.");
  }
  const validatedFormat: AdaptiveExportFormat = "pdf";

  // ── Load run + authorize access (mirrors GET /api/user/runs/[runId]) ──
  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }
  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");
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

  // ── Generate the PDF (deterministic, pure function of the frozen snapshot) ──
  const fullRecord: AdaptiveResearchExportV1 = {
    ...recordBase,
    reportVersion,
    exportMetadata: { ...recordBase.exportMetadata, finalReportVersion: reportVersion },
  };

  try {
    const { bytes, sha256 } = await renderAdaptiveResearchPdf(fullRecord);

    await markAdaptiveExportReady(runId, exportId, sha256);
    await supersedeOlderAdaptiveExports(runId, exportId);

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
    });

    const fileName = `convergepanel-export-${runId}-v${reportVersion}.pdf`;
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(bytes.length),
      },
    });
  } catch (err: unknown) {
    const failureReason = err instanceof Error ? err.message : "unknown_error";
    logger.error("[adaptive-export] PDF generation failed", { runId, exportId, errorMessage: failureReason });

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
    });

    return errorResponse(500, "pdf_generation_failed", "PDF generation failed. Please try again.");
  }
}
