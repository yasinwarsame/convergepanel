/**
 * TEAM_EXPORT_E1 — `POST /api/workspaces/{workspaceId}/runs/{runId}/export`:
 * the authorized Team Research artifact export. Creates a versioned export
 * record from a frozen report snapshot, renders it, and streams the bytes
 * back in one request. There is no separate download step and no durable
 * file object, exactly as the Personal route works — see researchExport.ts's
 * header comment for why the bytes are never stored.
 *
 * This is the Workspace SIBLING of `POST /api/user/runs/[runId]/export`, not
 * a generalization of it: the Personal route stays owner-only and untouched.
 * Every export primitive is reused verbatim (`buildExportSnapshot`,
 * `createAdaptiveExportRecord`, `renderAdaptiveResearchExport`,
 * `markAdaptiveExportReady`/`Failed`, `supersedeOlderAdaptiveExports`,
 * `writeAdaptiveExportAdminAuditEvent`) so the artifact a Team member
 * downloads is byte-comparable in construction to the Personal one, and so
 * E2 can replay the same frozen snapshot later.
 *
 * AUTHORIZATION ORDER IS SECURITY-CRITICAL and mirrors the sibling
 * `GET /api/workspaces/{workspaceId}/runs/{runId}` exactly:
 *
 *   1. identity                          → 401
 *   2. runId syntax                      → concealed 404
 *   3. ADAPTIVE_RESEARCH_EXPORT_ENABLED  → concealed 404 (feature absent)
 *   4. resolveTeamRunWorkspaceAccess()   → target-Workspace admission FIRST,
 *      zero-I/O, before any Workspace document is read; denial is concealed
 *      by the shared Team response helpers
 *   5. `exports.create` capability       → the family's 403
 *   6. run read + validateTeamRunRowShape(data, workspaceId) → concealed 404
 *   7. request format                    → 400
 *   8. snapshot + export verdict         → 403
 *
 * Steps 4-6 are three separate ENFORCEMENT POINTS and none substitutes for
 * another. Admission says the caller belongs to the addressed Workspace; the
 * capability says they may export at all; the row validation says the run
 * itself is canonically bound to that same Workspace. Only all three
 * together authorize an export, which is what makes a caller admitted to
 * Workspace A unable to export a run bound to Workspace B by supplying
 * either id in the path. The client-supplied `workspaceId` is a TARGET,
 * never an authority.
 *
 * Precisely: Workspace admission and `exports.create` are established before
 * any run access, and the DERIVED capability fact is then preserved as an
 * axis of the export verdict. That is one source of truth reused at two
 * layers, not two independent sources of authorization — the verdict's
 * capability axis cannot disagree with the gate, because it IS the gate's
 * value.
 *
 * Deliberately AFTER access and the run's binding: the request body is not
 * even parsed until the caller has been authorized for this run, so an
 * unauthorized caller cannot learn anything from format validation — the
 * Personal route can afford to validate format earlier because it has no
 * concealment obligation toward non-owners.
 *
 * DATA BOUNDARY — export changes representation, not authority. The invariant
 * is deliberately about AUTHORITY AMPLIFICATION, not an absolute ban on any
 * particular field:
 *
 *   Workspace export must not expose anything beyond what the same caller is
 *   already authorized to receive through the corresponding canonical Team
 *   Research read boundary.
 *
 * The snapshot carries the report, its sources and `humanReview` {status,
 * conditions, decidedVia}, and it carries no reviewer identity and no private
 * reviewer comment text, because `buildExportSnapshot()` never reads them.
 * It DOES carry `modelResponses: output.results` for the LEGACY family
 * (`exportSnapshot.ts`) — an earlier version of this comment wrongly claimed
 * "no raw model output". That is authorized, not a leak:
 * `buildRunReadPayload` returns the same `legacyAdaptive.output` unredacted to
 * every Team role, so export reveals nothing extra.
 *
 * The governance fields are exactly what the canonical Team detail read
 * already returns to a Workspace-authorized caller (`buildRunReadPayload` with
 * `mayReadDecisionContent: true`).
 *
 * An earlier version of this comment claimed "the roles that lose content
 * there — reviewer, viewer — are precisely the roles denied exports.create".
 * That is FALSE in both directions and R2 disproved it: a `viewer` loses
 * nothing (becoming `team_reviewer` requires `reviews.submit`, which
 * VIEWER_CAPABILITIES lacks, so a viewer is always `team_member`), and a
 * member/admin/owner — all of whom DO hold `exports.create` — loses per-model
 * `tokenUsage`/`latencyMs` when they are an assigned reviewer.
 *
 * The invariant does not depend on that role symmetry, and it survives a
 * fortiori: the redaction `buildRunReadPayload` applies for `team_reviewer`
 * (per-model `tokenUsage`/`latencyMs`) has NO counterpart in the export
 * snapshot to leak — `models` there is `{modelId, ok}` only. And every role
 * granted `exports.create` also holds `research.read` (asserted in
 * `lib/workspaces/__tests__/capabilities.spec.ts`), so every exporter already
 * has the canonical read authority for this content. So this route is not an
 * aggregation bypass around the cross-authority boundaries established by
 * PRs #186-#189.
 *
 * NOT in this slice (E1 is create + stream only): export history listing,
 * historical regeneration, Team UI, Project-scoped route wiring, Claim or
 * Video export, and sharing of any kind.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED, ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED, ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED } from "@/lib/env";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { runNotFoundConcealedResponse } from "@/lib/projects/projectErrorResponse";
import { validateTeamRunRowShape } from "@/lib/workspaces/teamRunRowValidation";
import { parsePersistedAdaptiveOutput, parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { canExportWorkspaceAdaptiveResearch } from "@/lib/adaptiveSchema/exportAuthorization";
import { resolveExportGeneratedBy } from "@/lib/adaptiveSchema/exportGeneratedBy";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { AdaptiveResearchExportV1, AdaptiveExportFormat, adaptiveExportContentType, adaptiveExportFileExtension } from "@/lib/adaptiveSchema/researchExport";
import { createAdaptiveExportRecord, markAdaptiveExportReady, markAdaptiveExportFailed, supersedeOlderAdaptiveExports } from "@/lib/firestore/adaptiveExports";
import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { writeAdaptiveExportAdminAuditEvent } from "@/lib/governance/auditLog";
import { logger } from "@/lib/logger";
import type { PlanId } from "@/lib/plans";
import type { ModelId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/runs/export POST]";

function errorResponse(status: number, errorCode: string, message: string) {
  return NextResponse.json({ ok: false, errorCode, message }, { status });
}

/** The shared Team/Project helpers return a `{status, body}` envelope rather than a response, exactly as the sibling detail route consumes them — this keeps the externally visible vocabulary identical across the Team run family. */
function shared(envelope: { status: number; body: unknown }) {
  return NextResponse.json(envelope.body as Record<string, unknown>, { status: envelope.status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/runs/[runId]/export", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return errorResponse(401, "unauthorized", "Please sign in.");
  }
  return errorResponse(401, "auth_error", "Authentication failed.");
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { workspaceId, runId } = params;

  if (!validateRunIdSyntax(runId).ok) {
    return shared(runNotFoundConcealedResponse());
  }

  // The feature's absence is concealed exactly as the Personal route
  // conceals it — a disabled export surface must be indistinguishable from
  // a route that does not exist.
  if (!ADAPTIVE_RESEARCH_EXPORT_ENABLED || !adminDb) {
    return shared(runNotFoundConcealedResponse());
  }

  // ── Gate 1: target-Workspace admission + membership (zero I/O first) ──
  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    // The shared mapper already routes `lookup_failed` to 503 and every
    // other reason to the family's concealed response — never re-derived here.
    return shared(teamRunAccessDeniedResponse(access.reason));
  }

  // ── Gate 2: the export capability itself, distinct from run access ──
  // Derived ONCE, here, from the canonical capability set the resolver
  // returned. This same value is the capability axis handed to the export
  // verdict below — never recomputed, never a route-local role list, and
  // never a literal (R1 P2-2: passing `true` made the verdict's own
  // capability branch unreachable and therefore untestable).
  const hasExportsCreate = access.capabilities.includes("exports.create");
  if (!hasExportsCreate) {
    return shared(teamRunInsufficientCapabilityResponse());
  }

  // ── Gate 3: the run must be canonically bound to THIS Workspace ──
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
    // Includes the cross-Workspace case: a run whose own `workspaceId` is
    // not the addressed one is concealed, never merely refused.
    return shared(runNotFoundConcealedResponse());
  }

  // ── Format (only now that the caller is authorized for this run) ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be valid JSON.");
  }
  const format = (body as { format?: unknown })?.format;
  const validFormats: AdaptiveExportFormat[] = ["pdf"];
  if (ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED) validFormats.push("docx");
  if (ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED) validFormats.push("json");
  if (typeof format !== "string" || !validFormats.includes(format as AdaptiveExportFormat)) {
    // A disabled-but-real format is rejected exactly like an unknown one —
    // never a flag-specific message that would reveal the feature exists.
    return errorResponse(400, "unsupported_format", `Only format: ${validFormats.map((f) => `"${f}"`).join(" or ")} is supported.`);
  }
  const validatedFormat: AdaptiveExportFormat = format as AdaptiveExportFormat;

  // ── Frozen snapshot (schema-family-aware, same builder as Personal) ──
  const question = String(data.question ?? "");
  const selectedModels = (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[];
  const parsedAdaptive = parsePersistedAdaptiveOutput(data.adaptiveOutput);
  const parsedLegacy = parsePersistedLegacyAdaptiveOutput(data.legacyAdaptiveOutput);

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
        // Same "unknown" default the Personal export and the Team detail read
        // both use for a history-style (not in-flight) read: never re-derive
        // routing here, and fail closed toward "still needs attention".
        reviewRouting: "unknown",
      },
    });
    schemaId = parsedAdaptive.output.schemaId;
    schemaFamily = "milestone2";
  } else if (parsedLegacy.ok) {
    const legacyStatus = data.governanceStatus;
    snapshotResult = buildExportSnapshot({
      question,
      selectedModels,
      legacy: {
        output: parsedLegacy.output,
        governanceStatus: legacyStatus === "approved" || legacyStatus === "needs_review" || legacyStatus === "blocked" ? legacyStatus : null,
      },
    });
    schemaId = parsedLegacy.output.schemaId;
    schemaFamily = "legacy";
  } else {
    return errorResponse(422, "no_report", "This run has no adaptive research report to export.");
  }

  const { reportSnapshot, governanceStatusAtExport, classification } = snapshotResult;

  // ── Export verdict: capability + caller plan + classification + governance ──
  // Plan axis. NOT "reused verbatim" from the Personal route: Personal export
  // resolves its plan through `loadUserAndTeam()`, while every Workspace write
  // in this repository (Team run creation, Team video creation) meters the
  // acting caller through `getEffectiveEntitlements()`. E1 follows the
  // Workspace precedent deliberately. The two sources can disagree (an active
  // admin override, or a stale `users.plan`), so this is a real behavioural
  // difference from Personal, stated rather than glossed.
  const entitlements = await getEffectiveEntitlements(uid);
  const verdict = canExportWorkspaceAdaptiveResearch({
    hasExportsCreateCapability: hasExportsCreate,
    planId: (entitlements?.planId as PlanId | undefined) ?? "free",
    classification,
    governanceStatusAtExport,
  });
  if (!verdict.allowed) {
    return errorResponse(403, verdict.reason, "You are not permitted to export this report.");
  }

  // ── Create the export record ("generating") ──
  const exportId = `exp-${randomUUID()}`;
  const nowIso = new Date().toISOString();
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
    // The ACTING caller, never the run's owner — Workspace authority is not
    // ownership, and E2 must be able to reconstruct who exported.
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

  // Same canonical `runs/{runId}/exports` subcollection as Personal: the run
  // document already carries the Workspace binding, so Workspace authority is
  // reconstructible from the run without a parallel export tree.
  const createResult = await createAdaptiveExportRecord({ runId, exportId, record: recordBase });
  if (!createResult.ok) {
    return errorResponse(500, "export_create_failed", "Could not start export generation. Please try again.");
  }
  const reportVersion = createResult.reportVersion;

  const fullRecord: AdaptiveResearchExportV1 = {
    ...recordBase,
    reportVersion,
    exportMetadata: { ...recordBase.exportMetadata, finalReportVersion: reportVersion },
  };

  const governanceStatusForAudit =
    governanceStatusAtExport.family === "milestone2" ? governanceStatusAtExport.kind : `legacy:${governanceStatusAtExport.status ?? "not_evaluated"}`;

  let bytes: Buffer;
  let sha256: string;
  const renderStartedAt = Date.now();
  try {
    const rendered = await renderAdaptiveResearchExport(fullRecord);
    bytes = rendered.bytes;
    sha256 = rendered.sha256;
  } catch (err: unknown) {
    const failureReason = err instanceof Error ? err.message : "unknown_error";
    logger.error(`${LOG} export generation failed`, { workspaceId, runId, exportId, format: validatedFormat, errorMessage: failureReason });

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
      governanceStatusAtExport: governanceStatusForAudit,
      at: new Date().toISOString(),
      failureReason,
      durationMs: Date.now() - renderStartedAt,
    });

    return errorResponse(500, "export_generation_failed", "Export generation failed. Please try again.");
  }
  const renderDurationMs = Date.now() - renderStartedAt;

  // The file genuinely exists from here on. Everything below is best-effort
  // bookkeeping around an ALREADY-successful export and must never turn it
  // into a failure for the client — same contract as the Personal route.
  try {
    const readyResult = await markAdaptiveExportReady(runId, exportId, sha256);
    if (!readyResult.ok) {
      logger.error(`${LOG} failed to mark export ready after successful generation`, { workspaceId, runId, exportId, reason: readyResult.reason });
    }

    const supersedeResult = await supersedeOlderAdaptiveExports(runId, exportId);
    if (!supersedeResult.ok) {
      logger.error(`${LOG} failed to supersede older exports`, { workspaceId, runId, exportId, reason: supersedeResult.reason });
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
      governanceStatusAtExport: governanceStatusForAudit,
      at: nowIso,
      durationMs: renderDurationMs,
      byteSize: bytes.length,
    });
  } catch (bookkeepingErr: unknown) {
    logger.error(`${LOG} post-generation bookkeeping failed (export itself still succeeded)`, {
      workspaceId,
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
