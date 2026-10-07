/**
 * TEAM_EXPORT_E2_B — `GET /api/workspaces/[workspaceId]/runs/[runId]/exports/[exportId]`
 *
 * Downloads an EXISTING historical Team export. There is no stored file (see
 * `lib/adaptiveSchema/researchExport.ts`): the export record's frozen
 * `reportSnapshot` is the durable artifact, and the bytes are rendered from it
 * on demand. This route therefore creates NO export record, NO reportVersion
 * and NO snapshot, and persists no bytes — it re-renders the frozen record and
 * streams it. The only write is the best-effort `adaptive_export_regenerated`
 * audit row.
 *
 * Authority (owner decision, 2026-10-08):
 *   CURRENT Workspace admission + CURRENT `research.read` (the capability that
 *   already lists this history, E2-A) + the ACTING caller's CURRENT plan
 *   entitlement + the record's FROZEN governance state. NOT `exports.create`:
 *   that governs creating new export work, which this route never does. The
 *   verdict is the dedicated `canAccessWorkspaceAdaptiveExport()`, never the
 *   creation verdict. `createdBy` is never authority.
 *
 * Order (each step only after every earlier one passes):
 *    1. authenticate;
 *    2. validate runId and exportId syntax BEFORE any document path is built;
 *    3. current Workspace admission;
 *    4. current `research.read`;
 *    5. master export flag — concealed until 3–4 pass, so an unauthorized
 *       caller cannot observe feature state (E1-S8/E2A-S3 precedent);
 *    6. canonical run/Workspace binding (`validateTeamRunRowShape`);
 *    7. Project integrity, exactly as E1/E2-A;
 *    8. frozen export record, with its runId/exportId binding verified;
 *    9. status gate: only `ready` and `superseded` are downloadable;
 *   10. acting caller's current entitlement (`getEffectiveEntitlements`);
 *   11. historical-access verdict: current plan + frozen governance;
 *   12. render strictly from the frozen record, in its STORED format — current
 *       per-format enablement flags are never consulted (Personal parity);
 *   13. best-effort audit, actor = the CURRENT caller (failure never turns a
 *       produced file into an error);
 *   14. stream the bytes.
 *
 * Foreign Workspace/run/export combinations are concealed exactly like a
 * missing run (404 `run_not_found`).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED } from "@/lib/env";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { runNotFoundConcealedResponse } from "@/lib/projects/projectErrorResponse";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { getProject } from "@/lib/firestore/projects";
import { getAdaptiveExportRecord } from "@/lib/firestore/adaptiveExports";
import { canAccessWorkspaceAdaptiveExport } from "@/lib/adaptiveSchema/exportAuthorization";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { adaptiveExportContentType, adaptiveExportFileExtension } from "@/lib/adaptiveSchema/researchExport";
import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { writeAdaptiveExportAdminAuditEvent } from "@/lib/governance/auditLog";
import { logger } from "@/lib/logger";
import type { PlanId } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/runs/exports/exportId GET]";

function errorResponse(status: number, errorCode: string, message: string) {
  return NextResponse.json({ ok: false, errorCode, message }, { status });
}

/** The shared Team/Project helpers return a `{status, body}` envelope; same consumption as the E1/E2-A siblings. */
function shared(envelope: { status: number; body: unknown }) {
  return NextResponse.json(envelope.body as Record<string, unknown>, { status: envelope.status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/runs/[runId]/exports/[exportId]", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return errorResponse(401, "unauthorized", "Please sign in.");
  }
  return errorResponse(401, "auth_error", "Authentication failed.");
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string; exportId: string } }) {
  // 1. authenticate
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { workspaceId, runId, exportId } = params;

  // 2. IDs are validated before any document path is constructed. An export id
  //    is a Firestore document id exactly like a run id, so the same rule
  //    applies (no "/", no control characters, no "."/"..", byte limit) —
  //    a malformed id can never redirect the reference to another document.
  if (!validateRunIdSyntax(runId).ok || !validateRunIdSyntax(exportId).ok) {
    return shared(runNotFoundConcealedResponse());
  }
  if (!adminDb) {
    return shared(runNotFoundConcealedResponse());
  }

  // 3. current Workspace admission
  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    return shared(teamRunAccessDeniedResponse(access.reason));
  }

  // 4. current `research.read` — derived ONCE here and handed to the verdict
  //    below as the same value, never recomputed and never a literal.
  const hasResearchRead = access.capabilities.includes("research.read");
  if (!hasResearchRead) {
    return shared(teamRunInsufficientCapabilityResponse());
  }

  // 5. master export flag, concealed until the caller is authorized
  if (!ADAPTIVE_RESEARCH_EXPORT_ENABLED) {
    return shared(runNotFoundConcealedResponse());
  }

  // 6. the run must be canonically bound to THIS Workspace
  let data: Record<string, unknown>;
  try {
    const snap = await adminDb.collection("runs").doc(runId).get();
    if (!snap.exists) {
      return shared(runNotFoundConcealedResponse());
    }
    data = (snap.data() ?? {}) as Record<string, unknown>;
  } catch (err: unknown) {
    logger.warn(`${LOG} run read failed`, { workspaceId, runId, error: err instanceof Error ? err.message : String(err) });
    return shared(teamRunLookupUnavailableResponse());
  }
  const validated = validateTeamRunRowShape(data, workspaceId);
  if (!validated.ok) {
    return shared(runNotFoundConcealedResponse());
  }

  // 7. Project integrity — same helper, same three outcomes as E1/E2-A
  if (validated.projectId !== null) {
    const projectResult = await getProject(validated.projectId);
    if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") {
      logger.warn(`${LOG} project read failed`, { workspaceId, runId, errorCategory: projectResult.status });
      return shared(teamRunLookupUnavailableResponse());
    }
    if (projectResult.status === "found" && projectResult.project.workspaceId !== workspaceId) {
      logger.warn(`${LOG} run filed in a Project of another Workspace (integrity anomaly)`, { workspaceId, runId });
      return shared(runNotFoundConcealedResponse());
    }
    if (projectResult.status !== "found") {
      logger.warn(`${LOG} filed run's Project unresolved`, { workspaceId, runId, errorCategory: projectResult.status });
    }
  }

  // 8. the frozen export record, bound to this run and this id
  const exportResult = await getAdaptiveExportRecord(runId, exportId);
  if (!exportResult.ok) {
    if (exportResult.reason === "not_found") {
      return shared(runNotFoundConcealedResponse());
    }
    logger.warn(`${LOG} export read failed`, { workspaceId, runId, exportId, errorCategory: exportResult.reason });
    return shared(teamRunLookupUnavailableResponse());
  }
  const record = exportResult.record;
  if (record.runId !== runId || record.exportId !== exportId) {
    logger.error(`${LOG} export/run binding mismatch`, { workspaceId, runId, exportId });
    return shared(runNotFoundConcealedResponse());
  }

  // 9. only a completed export is downloadable
  if (record.artifactStatus !== "ready" && record.artifactStatus !== "superseded") {
    return errorResponse(409, "export_not_ready", "This export never completed successfully and cannot be downloaded.");
  }

  // 10–11. the acting caller's CURRENT plan + the record's FROZEN governance
  const entitlements = await getEffectiveEntitlements(uid);
  const verdict = canAccessWorkspaceAdaptiveExport({
    hasResearchReadCapability: hasResearchRead,
    planId: (entitlements?.planId as PlanId | undefined) ?? "free",
    classification: record.classification,
    governanceStatusAtExport: record.governanceStatusAtExport,
  });
  if (!verdict.allowed) {
    return errorResponse(403, verdict.reason, "You are not permitted to access this export.");
  }

  // 12. render strictly from the frozen record, in its stored format
  let bytes: Buffer;
  const renderStartedAt = Date.now();
  try {
    const rendered = await renderAdaptiveResearchExport(record);
    bytes = rendered.bytes;
  } catch (err: unknown) {
    logger.error(`${LOG} regeneration failed`, { workspaceId, runId, exportId, errorMessage: err instanceof Error ? err.message : "unknown_error" });
    return errorResponse(500, "regeneration_failed", "Could not regenerate this export. Please try again.");
  }
  const renderDurationMs = Date.now() - renderStartedAt;

  // 13. best-effort audit, actor = the current caller
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
      governanceStatusAtExport:
        record.governanceStatusAtExport.family === "milestone2"
          ? record.governanceStatusAtExport.kind
          : `legacy:${record.governanceStatusAtExport.status ?? "not_evaluated"}`,
      at: new Date().toISOString(),
      durationMs: renderDurationMs,
      byteSize: bytes.length,
    });
  } catch (auditErr: unknown) {
    logger.error(`${LOG} regeneration audit write failed (the download itself still succeeded)`, {
      workspaceId,
      runId,
      exportId,
      errorMessage: auditErr instanceof Error ? auditErr.message : "unknown_error",
    });
  }

  // 14. stream
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
