/**
 * Order B, Stage B3 — GET /api/workspaces/{W}/runs/{R}/report-review/export?format=json|html
 *
 * The Report Review record export (see lib/workspaces/reportReviewExport.ts for why it is separate from the frozen
 * research exports, and what it contains). Streamed in one response; nothing is stored.
 *
 * Authorization, in order (each denial is the Team run family's existing response):
 *   identity → activation for THIS Workspace (switch + allow-list) + Approval Workflow admission + Workspace membership (reportReviewCaller: concealed 404 otherwise)
 *   → run-id syntax → Workspace access (resolveTeamRunWorkspaceAccess) → exports.create AND research.read AND
 *   reviews.read → format → run read → Workspace containment (validateTeamRunRowShape) → Project containment
 *   (a Project of another Workspace is concealed, as in the canonical read and the governed export, E1-S7)
 *   → a valid report review and no governance record → archived cycles contiguous and valid → build.
 * Research content comes from the canonical Team research read builder (`buildRunReadPayload`, same viewer-role
 * derivation as GET …/runs/{R}), so this export reveals nothing the caller could not already read.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { runNotFoundConcealedResponse } from "@/lib/projects/projectErrorResponse";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { getProject } from "@/lib/firestore/projects";
import { getAdaptiveHumanReviewAssignment } from "@/lib/firestore/runs";
import { deriveTeamRunViewerRole } from "@/lib/workspaces/deriveTeamRunViewerRole";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import { resolveRunReviewRouting } from "@/lib/runs/resolveRunReviewRouting";
import { compareReportReviewScope, parseReportReviewRecord, type ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { reportReviewCaller, reportReviewErrorBody } from "@/lib/workspaces/reportReviewRouteSupport";
import { REPORT_REVIEW_CYCLES_COLLECTION, REPORT_REVIEW_SNAPSHOTS_COLLECTION } from "@/lib/workspaces/reportReviewCollections";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { buildReportReviewExport, checkArchivedCycles, renderReportReviewExportHtml } from "@/lib/workspaces/reportReviewExport";
import { computeReportReviewContentFingerprint, sameReportReviewContent, verifyReportReviewContentSnapshot } from "@/lib/governance/reportReviewContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/runs/report-review/export GET]";
const ROUTE = "/api/workspaces/[workspaceId]/runs/[runId]/report-review/export";

function shared(envelope: { status: number; body: unknown }) {
  return NextResponse.json(envelope.body as Record<string, unknown>, { status: envelope.status });
}
function internal() {
  const { status, body } = internalErrorResponse();
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await reportReviewCaller(req, ROUTE, params.workspaceId, "GET");
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const { workspaceId } = params;

  const runIdResult = validateRunIdSyntax(params.runId);
  if (!runIdResult.ok) return shared(runNotFoundConcealedResponse());
  const runId = runIdResult.runId;
  if (!adminDb) return shared(runNotFoundConcealedResponse());

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) return shared(teamRunAccessDeniedResponse(access.reason));
  const caps = access.capabilities;
  if (!caps.includes("exports.create") || !caps.includes("research.read") || !caps.includes("reviews.read")) return shared(teamRunInsufficientCapabilityResponse());

  const format = req.nextUrl.searchParams.get("format");
  if (format !== "json" && format !== "html") return reportReviewErrorBody(400, "unsupported_format", 'Only format "json" or "html" is supported.');
  // S1: ?cycle=n exports that (archived) cycle's decision with ITS reviewed version; default is the current cycle.
  const cycleParam = req.nextUrl.searchParams.get("cycle");
  const requestedCycle = cycleParam === null ? null : /^[1-9][0-9]{0,5}$/.test(cycleParam) ? Number(cycleParam) : NaN;
  if (Number.isNaN(requestedCycle)) return reportReviewErrorBody(400, "invalid_cycle", "cycle must be a positive whole number.");

  let data: Record<string, unknown>;
  try {
    const snap = await adminDb.collection("runs").doc(runId).get();
    if (!snap.exists) return shared(runNotFoundConcealedResponse());
    data = (snap.data() ?? {}) as Record<string, unknown>;
  } catch (err) {
    logger.warn(`${LOG} run read failed`, { workspaceId, runId, error: err instanceof Error ? err.message : String(err) });
    return shared(teamRunLookupUnavailableResponse());
  }
  const validated = validateTeamRunRowShape(data, workspaceId);
  if (!validated.ok) return shared(runNotFoundConcealedResponse());
  if (validated.projectId !== null) {
    const projectResult = await getProject(validated.projectId);
    if (projectResult.status === "firestore_unavailable" || projectResult.status === "read_failed") return shared(teamRunLookupUnavailableResponse());
    if (projectResult.status === "found" && projectResult.project.workspaceId !== workspaceId) {
      logger.warn(`${LOG} run filed in a Project of another Workspace (integrity anomaly)`, { workspaceId, runId });
      return shared(runNotFoundConcealedResponse());
    }
  }

  if (data.deletion !== undefined && data.deletion !== null) return shared(runNotFoundConcealedResponse()); // S1: being deleted
  const parsed = parseReportReviewRecord(data.reportReview);
  if (!parsed.ok) {
    if (parsed.reason === "absent") return shared(runNotFoundConcealedResponse()); // nothing to export: concealed like any absent resource
    logger.warn(`${LOG} report review record malformed`, { workspaceId, runId });
    return internal();
  }
  if (data.governanceRecord !== undefined && data.governanceRecord !== null) {
    logger.error(`${LOG} run holds both review records (B1 invariant violated)`, { workspaceId, runId });
    return internal();
  }
  const record = parsed.record;

  let archived: { cycle: unknown; record: ReportReviewRecordV1 | null }[];
  try {
    const cyclesSnap = await adminDb.collection("runs").doc(runId).collection(REPORT_REVIEW_CYCLES_COLLECTION).get();
    archived = cyclesSnap.docs.map((d) => {
      const a = d.data() as { cycle?: unknown; record?: unknown };
      const r = parseReportReviewRecord(a.record);
      return { cycle: a.cycle, record: r.ok && String(a.cycle) === d.id ? r.record : null };
    });
  } catch (err) {
    logger.warn(`${LOG} cycle archive read failed`, { workspaceId, runId, error: err instanceof Error ? err.message : String(err) });
    return shared(teamRunLookupUnavailableResponse());
  }
  const history = checkArchivedCycles(record, archived);
  if (!history.ok) {
    logger.error(`${LOG} archived review cycles are not contiguous and valid; export refused`, { workspaceId, runId, cycle: record.cycle });
    return internal();
  }

  const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
  const viewerRole = deriveTeamRunViewerRole({ uid, capabilities: caps, assignmentResult, governanceRecord: data.governanceRecord });
  const payload = await buildRunReadPayload({ runId, data, viewerRole, mayReadDecisionContent: true, resolveReviewRouting: resolveRunReviewRouting });

  // The cycle being exported: the current one, or an archived one (?cycle=n).
  const target: ReportReviewRecordV1 | undefined = requestedCycle === null || requestedCycle === record.cycle ? record : history.cycles.find((c) => c.cycle === requestedCycle);
  if (!target) return shared(runNotFoundConcealedResponse());

  // S1: the exact reviewed content, from the write-once snapshot, re-verified (binding + digest) before it is exported.
  let reviewed: { content: Record<string, unknown> } | null = null;
  if (target.contentFingerprint) {
    let snapRaw: unknown;
    try {
      const snap = await adminDb.collection("runs").doc(runId).collection(REPORT_REVIEW_SNAPSHOTS_COLLECTION).doc(String(target.cycle)).get();
      snapRaw = snap.exists ? snap.data() : undefined;
    } catch (err) {
      logger.warn(`${LOG} snapshot read failed`, { workspaceId, runId, error: err instanceof Error ? err.message : String(err) });
      return shared(teamRunLookupUnavailableResponse());
    }
    const verified = verifyReportReviewContentSnapshot(snapRaw, { runId, workspaceId, cycle: target.cycle, fingerprint: target.contentFingerprint });
    if (!verified.ok) {
      logger.error(`${LOG} reviewed-content snapshot missing or does not verify; export refused`, { workspaceId, runId, cycle: target.cycle });
      return internal();
    }
    reviewed = { content: verified.content };
  }

  const drift = compareReportReviewScope(target.scope, data, target.submittedAt);
  // Order A: is the current research exactly what this cycle was submitted with? (server-computed, rrc-v1)
  const currentFp = computeReportReviewContentFingerprint(data);
  const contentIntegrity = !target.contentFingerprint || !currentFp.ok ? "unverifiable" : sameReportReviewContent(target.contentFingerprint, currentFp.fingerprint) ? "matches" : "changed";
  const doc = buildReportReviewExport({ generatedAt: new Date().toISOString(), runId, payload, record: target, currentRecord: record, archivedCycles: history.cycles, drift, contentIntegrity, reviewed });
  const filename = `report-review-${runId}-cycle-${target.cycle}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (format === "json") return new NextResponse(JSON.stringify(doc, null, 2), { status: 200, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
  return new NextResponse(renderReportReviewExportHtml(doc), { status: 200, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
