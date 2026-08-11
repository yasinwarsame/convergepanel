/**
 * Adaptive Research Export, Phase 2 —
 * GET /api/user/runs/[runId]/exports/[exportId].
 * Regenerates the PDF for an existing, historical export from its frozen
 * `reportSnapshot` — never from the current mutable run. This is the core
 * Phase 2 invariant: the only Firestore read here is the export record
 * itself; the current run document is never loaded, so there is no code
 * path by which a later run mutation could leak into a regenerated
 * historical PDF.
 *
 * Flow: authenticate → load run → authorize CURRENT access to the run
 * (ownership) → check ADAPTIVE_RESEARCH_EXPORT_ENABLED → load the frozen
 * export record → verify it actually belongs to this run (defense in
 * depth — Firestore's own subcollection nesting already makes cross-run
 * substitution structurally impossible, since `exportId` is only unique
 * within `runs/{runId}/exports`, but this is asserted explicitly rather
 * than relied on implicitly) → authorize export access using CURRENT
 * entitlement/ownership but the export's FROZEN classification/governance
 * state (Part 9 — "I had access once" must never become permanent; the
 * historical governance content itself must never be re-evaluated) →
 * version-aware render dispatch from the frozen snapshot → stream PDF
 * bytes → record a regeneration audit event.
 *
 * Entitlement (Part 10, explicit): regeneration requires the user's
 * CURRENT plan entitlement, not whatever entitlement was active when the
 * export was originally created. If a user's plan is downgraded below
 * `advancedExportEnabled` after creating an export, regeneration of that
 * export is denied going forward — access to historical exports tracks
 * current authorization, never a permanent grant frozen at creation time.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED } from "@/lib/env";
import { getAdaptiveExportRecord } from "@/lib/firestore/adaptiveExports";
import { adaptiveExportContentType, adaptiveExportFileExtension } from "@/lib/adaptiveSchema/researchExport";
import { resolveAdaptiveExportVerdict } from "@/lib/adaptiveSchema/exportAuthorization";
import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { writeAdaptiveExportAdminAuditEvent } from "@/lib/governance/auditLog";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/runs/[runId]/exports/[exportId]", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function errorResponse(status: number, errorCode: string, message: string) {
  return NextResponse.json({ ok: false, errorCode, message }, { status });
}

export async function GET(req: NextRequest, context: { params: Promise<{ runId: string; exportId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!ADAPTIVE_RESEARCH_EXPORT_ENABLED) {
    return errorResponse(404, "not_found", "Not found.");
  }

  const { runId, exportId } = await context.params;
  if (!runId?.trim() || !exportId?.trim() || !adminDb) {
    return errorResponse(404, "not_found", "Not found.");
  }

  // ── Current access to the run (ownership re-checked now, not trusted from any earlier session) ──
  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return errorResponse(404, "not_found", "Not found.");
  }
  const runData = runSnap.data() as Record<string, unknown>;
  const owner = String(runData.userId ?? "");
  if (owner !== uid) {
    // Same generic "not_found" as a genuinely missing export — never reveal
    // whether a foreign run/export combination exists (Part 5/23).
    return errorResponse(404, "not_found", "Not found.");
  }

  // ── Load the frozen export record and verify run/export binding ──
  const exportResult = await getAdaptiveExportRecord(runId, exportId);
  if (!exportResult.ok) {
    return errorResponse(404, "not_found", "Not found.");
  }
  const record = exportResult.record;
  if (record.runId !== runId || record.exportId !== exportId) {
    // Should be structurally unreachable (Firestore subcollection nesting
    // already scopes exportId to its own runId), but asserted explicitly
    // rather than assumed — a malformed/migrated record must never render.
    logger.error("[adaptive-export] export/run binding mismatch", { runId, exportId, recordRunId: record.runId, recordExportId: record.exportId });
    return errorResponse(404, "not_found", "Not found.");
  }
  if (record.artifactStatus === "failed" || record.artifactStatus === "generating") {
    return errorResponse(409, "export_not_ready", "This export never completed successfully and cannot be regenerated.");
  }

  // ── Authorization (Part 9): CURRENT ownership/entitlement, FROZEN classification/governance ──
  const verdict = await resolveAdaptiveExportVerdict(uid, owner, record.classification, record.governanceStatusAtExport);
  if (!verdict.allowed) {
    return errorResponse(403, verdict.reason, "You are not permitted to access this export.");
  }

  // ── Version-aware regeneration — pure function of the frozen record, never the current run (Part 4/6/7) ──
  let bytes: Buffer;
  const renderStartedAt = Date.now();
  try {
    const rendered = await renderAdaptiveResearchExport(record);
    bytes = rendered.bytes;
  } catch (err: unknown) {
    const failureReason = err instanceof Error ? err.message : "unknown_error";
    logger.error("[adaptive-export] regeneration failed", { runId, exportId, errorMessage: failureReason });
    return errorResponse(500, "regeneration_failed", "Could not regenerate this PDF. Please try again.");
  }
  const renderDurationMs = Date.now() - renderStartedAt;

  // Best-effort audit — a failure here must never turn an already-successful
  // regeneration into a failed response (same reliability semantics as the
  // creation route's own post-generation bookkeeping).
  try {
    await writeAdaptiveExportAdminAuditEvent({
      exportId,
      action: "adaptive_export_regenerated",
      actorUid: uid,
      runId,
      schemaId: record.schemaId,
      schemaFamily: record.schemaFamily,
      classification: record.classification,
      format: record.format,
      reportVersion: record.reportVersion,
      governanceStatusAtExport: record.governanceStatusAtExport.family === "milestone2" ? record.governanceStatusAtExport.kind : `legacy:${record.governanceStatusAtExport.status ?? "not_evaluated"}`,
      at: new Date().toISOString(),
      durationMs: renderDurationMs,
      byteSize: bytes.length,
    });
  } catch (auditErr: unknown) {
    logger.error("[adaptive-export] regeneration audit write failed (regeneration itself still succeeded)", {
      runId,
      exportId,
      errorMessage: auditErr instanceof Error ? auditErr.message : "unknown_error",
    });
  }

  // Part 13 invariant — a historical record regenerates in its OWN frozen
  // format, never a client-chosen one: `record.format` (not any request
  // input) drives both the renderer dispatch above and these headers. A
  // PDF export can never be coerced into a DOCX response or vice versa.
  const fileName = `convergepanel-export-${runId}-v${record.reportVersion}.${adaptiveExportFileExtension(record.format)}`;
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": adaptiveExportContentType(record.format),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(bytes.length),
    },
  });
}
