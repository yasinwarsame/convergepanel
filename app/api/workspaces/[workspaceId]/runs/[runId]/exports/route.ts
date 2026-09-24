/**
 * TEAM_EXPORT_E2_A — `GET /api/workspaces/{workspaceId}/runs/{runId}/exports`:
 * the authorized Team Research export HISTORY list. Metadata only. No
 * rendering, no streaming, no regeneration, no creation, no writes, and the
 * frozen `reportSnapshot` never leaves the server through this route.
 *
 * Workspace sibling of `GET /api/user/runs/[runId]/exports`, which stays
 * owner-only and untouched. This route REUSES THE SAME export-history helper
 * Personal uses (`listAdaptiveExportRecords`), so ordering, the cursor contract
 * and the [1,50] clamp have one implementation rather than two. That is the
 * provable claim and the only one made here — the earlier "byte-for-byte the
 * Personal list item" wording was true when written but pinned by no test, so
 * it is not repeated as a guarantee.
 *
 * SECURITY INVARIANTS. Each carries an id and names the test that falsifies it;
 * a claim without one is description, not a guarantee. (This header does NOT
 * restate the execution order as a numbered list — the table IS the contract,
 * because a second ordered description is a second thing to drift.)
 *
 *   E2A-S1  Workspace admission precedes ALL target-associated I/O — the run, the
 *           Project, and the export subcollection. R1 found the Project read was
 *           outside the instrumented boundary, so a mutation moving it above
 *           admission survived; it is now counted.
 *           → spec "a NON-MEMBER performs zero run, Project and export I/O"
 *   E2A-S2  `research.read` precedes ALL target-associated I/O, same three reads.
 *           → spec "a caller WITHOUT research.read performs zero run, Project and export I/O"
 *   E2A-S3  Global export feature state is concealed until admission and
 *           `research.read` have both succeeded.
 *           → spec "a non-member cannot distinguish the flag state" + the
 *             capability-denied pair + the authorized positive control
 *   E2A-S4  Pagination input must not create an externally observable error
 *           distinction before Workspace authorization — valid, malformed and
 *           absurd paging are indistinguishable to an unauthorized caller.
 *           → spec "an unauthorized caller cannot distinguish pagination validity"
 *           FALSIFIER, stated precisely because the obvious one does not work:
 *           MOVING the parse above admission proves nothing — it is a pure
 *           computation that never errors (malformed input falls back to the
 *           first page and the default size), so relocating it is an equivalent
 *           mutant and the suite stays green. The violating mutation is to make
 *           paging VALIDATION RESPOND — e.g. a 400 `invalid_cursor` — before
 *           authorization; that kills the named test, while the identical 400
 *           placed after authorization does not. Position matters only once
 *           there is something to observe.
 *   E2A-S5  A malformed `runId` cannot redirect the reference to another
 *           document or subcollection.
 *           → spec "runId syntax is load-bearing for path integrity"
 *   E2A-S6  Current Workspace/run/Project authority governs history access —
 *           never historical membership.
 *           → spec cross-Workspace, Project-anomaly and former-member cases
 *   E2A-S7  Creator identity is not authority: `createdBy` is metadata. A
 *           currently authorized NON-creator may list; a removed creator may not.
 *           → spec "a current reader who did not create the exports can list them"
 *   E2A-S8  The response exposes only the approved metadata DTO — never
 *           `reportSnapshot` or any other persisted non-DTO field. Stated as an
 *           allow-list, which is what the projection actually is. R1 removed an
 *           earlier "no governance record / no reviewer-private field" clause:
 *           `AdaptiveResearchExportV1` has no such key and `buildExportSnapshot`
 *           emits none, so that claim was trivially true and its fixture named a
 *           shape production cannot produce.
 *           → spec "the response exposes only the approved metadata DTO"
 *   E2A-S9  LIST is gated on `research.read`, NOT `exports.create` — a reader who
 *           cannot create exports can still read their history.
 *           → spec "a role with research.read but WITHOUT exports.create can list"
 *   E2A-S10 This route owns NO pagination policy: it forwards a finite,
 *           truncated cursor/limit (or `undefined`) and never clamps, so the
 *           [1,50] bound has exactly one implementation — the shared helper's.
 *           → spec "does not clamp in the route — the helper owns the [1,50] bound"
 *
 * WHAT IS SHARED WITH PERSONAL, AND WHAT IS ONLY DUPLICATED. R1 asked that no
 * parity claim survive unproven. Genuinely shared, therefore one
 * implementation: `listAdaptiveExportRecords` — ordering, the cursor query and
 * the clamp. NOT shared, merely identical source today: the query-parameter
 * parse and the `format !== "docx"` hash derivation are duplicated in both
 * routes, and no cross-route test pins them together. This route's own tests
 * pin its own behaviour; they cannot detect Personal drifting away from it.
 * Treated as known duplication rather than claimed as parity — de-duplicating
 * it would edit the Personal route, which is out of scope for E2-A.
 *
 * WHY THE FLAG IS CHECKED LATE. The Personal route checks
 * `ADAPTIVE_RESEARCH_EXPORT_ENABLED` before its owner check, which it can afford
 * because it owes non-owners no concealment. This route deliberately does NOT
 * copy that ordering: it inherits E1-S8, so an unauthorized caller must not be
 * able to determine whether Workspace export is globally enabled. The same
 * reasoning applies to query-parameter validation (E2A-S4) — a 400 about a bad
 * cursor would tell a non-member the route exists and reached its paging layer.
 *
 * DELIBERATELY ABSENT, and each absence is load-bearing rather than an
 * oversight: no export verdict, no plan/entitlement check, no classification or
 * governance re-evaluation, and no audit event. LIST is a read of export history
 * by a current Research reader, deferring per-item authorization to the
 * regeneration route (the Personal list, read at this SHA, makes the same
 * choices — an observation about current code, not a pinned contract). Plan and
 * the frozen-governance verdict belong to E2-B, which will require
 * `exports.create`; folding them in here would quietly turn a read into E1.
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
import { listAdaptiveExportRecords } from "@/lib/firestore/adaptiveExports";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[api/workspaces/runs/exports GET]";

/** The export-history metadata DTO. Its key set is pinned by the spec's allow-list assertion, so drift is caught there rather than asserted in prose; correspondence with the Personal list item is not claimed as a guarantee. `reportSnapshot` is absent by construction — this is an allow-list projection, not a denylist. */
export interface TeamAdaptiveExportListItem {
  exportId: string;
  reportVersion: number;
  schemaId: string;
  schemaFamily: "milestone2" | "legacy";
  format: string;
  artifactStatus: string;
  createdAt: string;
  createdBy: string;
  governanceStatusAtExport: unknown;
  classification: string;
  fileHash?: string;
  hashAlgorithm?: "sha256";
  hashReproducible?: boolean;
}

/** Derived purely from `format` — DOCX regeneration cannot reproduce its original whole-file hash. Duplicates the Personal list's one-line derivation; identical today, pinned together by no test (see the header's shared-vs-duplicated note). */
function isHashReproducible(format: string): boolean {
  return format !== "docx";
}

function errorResponse(status: number, errorCode: string, message: string) {
  return NextResponse.json({ ok: false, errorCode, message }, { status });
}

/** The shared Team/Project helpers return a `{status, body}` envelope; emitting them this way keeps the concealment vocabulary identical across the Team run family. */
function shared(envelope: { status: number; body: unknown }) {
  return NextResponse.json(envelope.body as Record<string, unknown>, { status: envelope.status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/runs/[runId]/exports", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return errorResponse(401, "unauthorized", "Please sign in.");
  }
  return errorResponse(401, "auth_error", "Authentication failed.");
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string; runId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { workspaceId, runId } = params;

  // E2A-S5 — before any document path is constructed from it.
  if (!validateRunIdSyntax(runId).ok) {
    return shared(runNotFoundConcealedResponse());
  }

  // `!adminDb` only. The feature flag is checked LATER (E2A-S3). That this
  // infrastructure branch answers with the family's concealed 404 rather than
  // the sibling detail route's 503 is a known, separately tracked divergence,
  // unchanged here.
  if (!adminDb) {
    return shared(runNotFoundConcealedResponse());
  }

  // ── E2A-S1: admission must precede any target-run or export I/O ──
  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    return shared(teamRunAccessDeniedResponse(access.reason));
  }

  // ── E2A-S2 / E2A-S9: `research.read`, NOT `exports.create` ──
  // History is a READ of the Research run's export metadata, so it is gated
  // exactly like the canonical Team detail read. A reviewer or viewer — who
  // holds `research.read` but is denied `exports.create` — can therefore see
  // that exports exist without being able to create or download one.
  if (!access.capabilities.includes("research.read")) {
    return shared(teamRunInsufficientCapabilityResponse());
  }

  // ── E2A-S3: global feature state concealed until authorization ──
  // As with E1-S8, the deliberate cost is that a disabled surface still
  // performs the reads admission and capability evaluation require; the
  // protected property is only that an unauthorized caller cannot observe
  // flag state.
  if (!ADAPTIVE_RESEARCH_EXPORT_ENABLED) {
    return shared(runNotFoundConcealedResponse());
  }

  // ── E2A-S4: pagination input creates no observable error ──
  // The finite/truncation guards are duplicated from the Personal list — same
  // source today, not a shared implementation. `Number.isFinite` also rejects
  // ±Infinity and `Math.trunc` keeps a fractional value out of Firestore's
  // `.limit()`/`.where("<", …)`. `listAdaptiveExportRecords` re-applies its own clamp regardless, so
  // a client can never force an unbounded read. Malformed values fall back to
  // the first page and the default size rather than erroring — and THAT, not
  // this block's position, is what makes paging unobservable to an
  // unauthorized caller. Keep it that way: adding a 4xx for bad paging would
  // create the oracle, and it would do so wherever the parse happens to sit.
  const cursorParam = req.nextUrl.searchParams.get("cursor");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const parsedCursor = cursorParam !== null ? Number(cursorParam) : NaN;
  const parsedLimit = limitParam !== null ? Number(limitParam) : NaN;
  const beforeReportVersion = Number.isFinite(parsedCursor) ? Math.trunc(parsedCursor) : undefined;
  const limit = Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : undefined;

  // ── E2A-S6: the run must be canonically bound to THIS Workspace ──
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
    // Includes the cross-Workspace case: a run whose own `workspaceId` is not
    // the addressed one is concealed, never merely refused.
    return shared(runNotFoundConcealedResponse());
  }

  // ── E2A-S6: Project binding integrity, mirroring the canonical read ──
  // Same helper and same three outcomes as the detail read and E1: a run filed
  // in another Workspace's Project is an integrity anomaly and is concealed, so
  // export history cannot be listed for a run the canonical read would refuse.
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
  }

  // ── The list itself ──
  // E2A-S7: authority was settled entirely above, from the CURRENT caller's
  // Workspace standing. Nothing below consults `createdBy`; it is projected as
  // metadata only, so a current reader who created none of these exports sees
  // them, and a removed creator sees nothing because they never get here.
  const listResult = await listAdaptiveExportRecords(runId, { limit, beforeReportVersion });
  if (!listResult.ok) {
    // R1 INFORMATIONAL-3: one underlying condition used to surface as two codes
    // — 503 when the run read failed, 500 here. Normalised route-locally on the
    // helper's OWN TYPED reasons (`"firestore_unavailable" | "read_failed"`,
    // the same pair the run read maps to 503), so infrastructure failure has a
    // single contract on this route. Deliberately NOT a blanket catch and NOT a
    // change to the shared helper, which Personal also consumes: an unexpected
    // reason still falls through to 500 rather than being laundered into 503.
    if (listResult.reason === "firestore_unavailable" || listResult.reason === "read_failed") {
      logger.warn(`${LOG} export history read failed`, { workspaceId, runId, errorCategory: listResult.reason });
      return shared(teamRunLookupUnavailableResponse());
    }
    return errorResponse(500, "list_failed", "Could not load export history. Please try again.");
  }

  // E2A-S8: an explicit allow-list projection. The frozen `reportSnapshot`, the
  // governance record and every reviewer-private field are absent because they
  // are never copied here — not because a denylist strips them.
  const items: TeamAdaptiveExportListItem[] = listResult.records.map((r) => ({
    exportId: r.exportId,
    reportVersion: r.reportVersion,
    schemaId: r.schemaId,
    schemaFamily: r.schemaFamily,
    format: r.format,
    artifactStatus: r.artifactStatus,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    governanceStatusAtExport: r.governanceStatusAtExport,
    classification: r.classification,
    ...(r.exportMetadata.fileHash
      ? { fileHash: r.exportMetadata.fileHash, hashAlgorithm: "sha256" as const, hashReproducible: isHashReproducible(r.format) }
      : {}),
  }));

  const nextCursor = listResult.hasMore && items.length > 0 ? items[items.length - 1].reportVersion : null;

  return NextResponse.json({ ok: true, runId, exports: items, hasMore: listResult.hasMore, nextCursor });
}
