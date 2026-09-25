/**
 * TEAM_EXPORT_E2_A — `GET /api/workspaces/{workspaceId}/runs/{runId}/exports`:
 * the authorized Team Research export HISTORY list. Metadata only. No
 * rendering, no streaming, no regeneration, no creation, no writes, and the
 * frozen `reportSnapshot` never leaves the server through this route.
 *
 * Workspace sibling of `GET /api/user/runs/[runId]/exports`, which stays
 * owner-only and is untouched by this PR.
 *
 * WHAT IS SHARED WITH PERSONAL. Of the EXPORT-LIST logic, one thing:
 * `listAdaptiveExportRecords`. It owns the query —
 * `orderBy("reportVersion","desc")`, the `where("<", cursor)` range,
 * `limit+1`/`hasMore`, and the `[1,50]` clamp (pinned in
 * `lib/firestore/__tests__/adaptiveExports.spec.ts`). Route-level authority and
 * request handling are entirely separate. (This is deliberately NOT a claim that
 * the two routes share only one module: they both import the same
 * `resolveRequestIdentity`, `logIdentityResolutionFailure`, `env`, `adminDb` and
 * `logger`, as any two routes in this codebase do, and their `getUid` helpers are
 * near-verbatim duplicates. Generic infrastructure being shared is not the point;
 * the point is which EXPORT-LIST semantics have one implementation.) Everything
 * else in the export-list path that looks shared is DUPLICATED source: the
 * query-parameter parse, the `nextCursor` derivation and the
 * `format !== "docx"` hash rule each exist separately in both routes, identical
 * today and pinned together by no test. An earlier version of
 * this header claimed "ordering, the cursor contract and the [1,50] clamp have
 * one implementation rather than two"; the cursor contract's client-facing half
 * is two implementations, so the claim was false and is withdrawn rather than
 * re-scoped. No inventory of duplications is maintained here — one that drifts
 * out of date is worse than none; the rule is simply that nothing in this file
 * may be described as shared unless it is literally the same function.
 *
 * SECURITY INVARIANTS. Each carries an id and names, VERBATIM, the test that
 * falsifies it; a claim without one is description, not a guarantee. The table
 * IS the ordering contract — there is deliberately no second numbered
 * restatement of the execution order, because that is a second thing to drift.
 *
 *   E2A-S1  Workspace admission precedes ALL target-associated I/O — the run,
 *           the Project and the export subcollection.
 *           → "E2A-S1 a NON-MEMBER performs zero run, Project and export I/O"
 *   E2A-S2  `research.read` precedes ALL target-associated I/O, same three reads.
 *           → "E2A-S2 a caller WITHOUT research.read performs zero run, Project and export I/O"
 *   E2A-S3  Global export feature state is concealed until admission and
 *           `research.read` have both succeeded.
 *           → "a non-member cannot distinguish the flag state"
 *           → "a caller without research.read cannot distinguish the flag state"
 *           → "POSITIVE CONTROL: an authorized reader DOES observe the flag"
 *   E2A-S4  Pagination input must not create an externally observable error
 *           distinction before Workspace authorization.
 *           → "an unauthorized caller cannot distinguish pagination validity"
 *           FALSIFIER, stated precisely because the obvious one does not work:
 *           MOVING the parse above admission proves nothing — it is pure
 *           computation that never errors, so relocating it is an equivalent
 *           mutant and the suite stays green (verified twice, R1 and R2). The
 *           violating mutation is to make paging validation RESPOND — a 400
 *           `invalid_cursor` — BEFORE authorization; that kills the named test,
 *           while the identical 400 placed after authorization does not. The
 *           invariant is response-scoped, not source-line-scoped.
 *   E2A-S5  A malformed `runId` cannot redirect the reference to another
 *           document or subcollection.
 *           → "E2A-S5 — runId syntax is load-bearing for path integrity" (6 cases)
 *   E2A-S6  Current Workspace/run/Project authority governs history access —
 *           never historical membership.
 *           → "E2A-S6 CROSS-WORKSPACE: a run bound to another Workspace is concealed and never listed"
 *           → "E2A-S6 a Project belonging to another Workspace is concealed"
 *           → "E2A-S6/S7 a FORMER member — including the export creator — is concealed"
 *   E2A-S7  Creator identity is not authority: `createdBy` is metadata. A
 *           currently authorized NON-creator may list; a removed creator may not.
 *           → "E2A-S7 a current reader who did NOT create the exports receives them"
 *   E2A-S8  The E2-A LIST response contains only the approved export metadata
 *           DTO — at the item level AND the envelope level. NO field and no
 *           NESTED LEAF of the frozen `reportSnapshot` is projected into the
 *           response. R3 showed why the nested half has to be said out loud: the
 *           old fixture populated only `reportSnapshot.question`, so extracting
 *           `milestone2.decisionReceipt`, `milestone2.meta`, the five top-level
 *           report leaves or the whole `legacy` branch LEAF BY LEAF passed the
 *           entire suite. A wholesale `reportSnapshot: r.reportSnapshot` was
 *           caught; field-by-field was invisible, because an absent fixture leaf
 *           serializes as nothing.
 *           → "E2A-S8 the response exposes only the approved metadata DTO — proved against what E1 really persists"
 *           → "E2A-S8 no milestone2 reportSnapshot leaf reaches the response"
 *           → "E2A-S8 no legacy reportSnapshot leaf reaches the response"
 *   E2A-S15 A paging envelope is never self-contradictory: `hasMore: true` is
 *           emitted only together with a usable continuation cursor.
 *           → "a page that cannot yield a continuation cursor is an integrity failure, not a trap"
 *           → "a NON-NUMERIC reportVersion is refused the same way"
 *           → "hasMore with an EMPTY page cannot crash or invent a cursor"
 *           → "POSITIVE CONTROL: hasMore with a usable terminal reportVersion still pages"
 *   E2A-S9  LIST is gated on `research.read`, NOT `exports.create`.
 *           → "E2A-S9 a role with research.read but WITHOUT exports.create can list"
 *   E2A-S9b The gate asks for `research.read` SPECIFICALLY, not a capability
 *           that today's role matrix happens to co-grant.
 *           → "a caller holding reviews.read AND exports.create but NOT research.read is refused"
 *   E2A-S10 This route owns NO pagination policy: it forwards a finite,
 *           truncated cursor/limit (or `undefined`) and never clamps.
 *           → "does not clamp in the route — the helper owns the [1,50] bound (one implementation)"
 *   E2A-S11 Admission is evaluated for the AUTHENTICATED caller against the
 *           ADDRESSED Workspace — not merely called in the right order. R2
 *           found both dimensions unpinned: `uid: "attacker-static"` and
 *           `workspaceId: runId` each passed the whole suite.
 *           → "E2A-S11a admission receives the AUTHENTICATED caller's uid"
 *           → "E2A-S11b admission receives the ADDRESSED workspaceId"
 *           → both CONTROLs, which prove the fake discriminates per dimension
 *   E2A-S12 The Project-integrity read targets `validated.projectId` — not some
 *           other id that happens to be in scope. `getProject(workspaceId)`
 *           previously passed the whole suite.
 *           → "E2A-S12 getProject receives validated.projectId"
 *   E2A-S13 An UNFILED run (`projectId === null`) is listable and performs NO
 *           Project read.
 *           → "E2A-S13 an UNFILED run (projectId null) lists WITHOUT any Project read"
 *   E2A-S14 The export-history read is scoped to the addressed run.
 *           → "E2A-S14 the helper receives the addressed runId"
 *
 * WHERE THE E2A-S8 GUARANTEE ACTUALLY COMES FROM — three mechanisms, not one,
 * and not from "every persisted field carries a sentinel" (an earlier revision
 * said that; seven non-DTO fixture fields carry ordinary values):
 *   1. the exact DTO key allow-list, at both the item and envelope level, which
 *      catches ANY added key including ones no sentinel covers;
 *   2. targeted sentinel VALUES on the representative and highest-risk persisted
 *      non-DTO fields — `generatedBy`, `failureReason`, `exportMetadata`'s own
 *      leaves, and every `reportSnapshot` leaf;
 *   3. RECURSIVE hostile `reportSnapshot` fixtures for BOTH schema families, so
 *      a nested leaf cannot be "proved absent" merely by being absent from the
 *      fixture.
 *
 * FIXTURE FIDELITY IS RECURSIVE (the permanent rule from R3). A nested field can
 * only prove non-disclosure if the production-valid fixture actually contains a
 * non-undefined value at that exact path BEFORE DTO projection. Absent nested
 * values are not evidence — they are the absence of evidence, and
 * `JSON.stringify` erases the difference at every depth.
 *
 * THE AUTHORITY-MOCK RULE (adopted in R2). A mocked security collaborator
 * is not proven by having been called: its security-relevant arguments must be
 * pinned, and where practical the fake must BEHAVE DIFFERENTLY when they are
 * wrong. Caller identity, Workspace identity, Project identity, capability
 * identity and run identity are all argument-sensitive in the spec, each with a
 * CONTROL test proving the fake discriminates — otherwise the fake becomes the
 * next assertion that cannot fail.
 *
 * WHY THE FLAG IS CHECKED LATE. The Personal route checks
 * `ADAPTIVE_RESEARCH_EXPORT_ENABLED` before its owner check, which it can afford
 * because it owes non-owners no concealment. This route deliberately does NOT
 * copy that ordering: it inherits E1-S8, so an unauthorized caller must not be
 * able to determine whether Workspace export is globally enabled. The same
 * reasoning applies to query-parameter validation (E2A-S4) — a 400 about a bad
 * cursor would tell a non-member the route exists and reached its paging layer.
 *
 * PAGINATION SEMANTICS, stated per input class rather than as one sweeping
 * "malformed values fall back to the first page and the default size" — R2
 * showed that sentence was false for one of the four classes:
 *
 *   absent      (`?`)                 → `undefined`; the helper applies its own
 *                                       default page size of 30. First page.
 *   malformed   (`?cursor=abc`)       → `undefined`; genuine fallback, as above.
 *   finite      (`?cursor=12.7`)      → truncated to `12`; forwarded as given.
 *   EMPTY       (`?cursor=`)          → `0`, NOT absent. `searchParams.get()`
 *                                       returns `""` rather than `null`, and
 *                                       `Number("") === 0`, which is finite. The
 *                                       helper then applies
 *                                       `where("reportVersion","<",0)` and a run
 *                                       WITH exports reports none. `?limit=`
 *                                       likewise forwards `0`, which the helper
 *                                       clamps UP to 1 instead of defaulting to 30.
 *
 * The empty-string case is a DEFECT, tracked as
 * SHARED_EXPORT_HISTORY_EMPTY_QUERY_PARAM_NORMALIZATION and deliberately NOT
 * fixed here. The identical parse exists in the Personal list, and normalizing
 * it on one surface only would replace a shared inconsistency with a divergence
 * between two surfaces that clients reasonably expect to behave alike. It is
 * characterized by tests ("empty query parameters — inherited behaviour,
 * characterized not endorsed") so the behaviour is recorded rather than
 * discovered again, and the future fix updates BOTH surfaces together. E2A-S4 is
 * unaffected: all four classes remain equally unobservable before authorization.
 *
 * DELIBERATELY ABSENT, and each absence is load-bearing rather than an
 * oversight: no export verdict, no plan/entitlement check, no classification or
 * governance re-evaluation, and no audit event. LIST is a read of export history
 * by a current Research reader, deferring per-item authorization to the
 * regeneration route. Plan and the frozen-governance verdict belong to E2-B,
 * which will require `exports.create`; folding them in here would quietly turn a
 * read into E1.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED } from "@/lib/env";
import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse, teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";
import type { TeamWorkspaceErrorBody } from "@/lib/workspaces/teamWorkspaceErrorResponse";
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

/**
 * R2 P3-5/§25: the shared `teamRunLookupUnavailableResponse()` says "We couldn't
 * verify your access right now", which is accurate for an ADMISSION lookup
 * failure and wrong for a failure three stages later, after access was already
 * verified. The shared helper is NOT route-owned — `teamRunAccessDeniedResponse`
 * maps `lookup_failed` through it and E1 and the canonical read both emit it —
 * so editing its text would change other routes' user-facing strings. Instead
 * this route keeps the PRIMARY contract byte-identical (503 +
 * `team_workspace_unavailable`, the same status and errorCode the family uses)
 * and supplies a stage-accurate generic message for its own post-authorization
 * failures. Clients must key on status/errorCode, never on wording.
 */
function unavailableAfterAuthorization(): { status: number; body: TeamWorkspaceErrorBody } {
  const base = teamRunLookupUnavailableResponse();
  return { status: base.status, body: { ...base.body, message: "We couldn't load this export history right now. Please try again in a moment." } };
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
    return shared(unavailableAfterAuthorization());
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
      return shared(unavailableAfterAuthorization());
    }
    if (projectResult.status === "found" && projectResult.project.workspaceId !== workspaceId) {
      logger.warn(`${LOG} run filed in a Project of another Workspace (integrity anomaly)`, { workspaceId, runId });
      return shared(runNotFoundConcealedResponse());
    }
    // R3 P2: `not_found` and `malformed` are NOT integrity anomalies — a
    // Project document that is simply gone says nothing about which Workspace
    // this run belongs to, which `validateTeamRunRowShape` already settled. The
    // canonical Team detail read logs and renders the run without a Project
    // label, and E1 logs and exports; E2-A carries no Project label either, so
    // it logs and lists. Behaviourally the two statuses are identical in all
    // three routes — the distinction survives in `errorCategory`, not in the
    // response — and turning them into a refusal would make export history
    // unlistable for a run the canonical read still renders. E2-A previously
    // logged NOTHING here, so a run listing against a vanished Project left no
    // operator trace at all; that asymmetry with its two siblings is fixed.
    if (projectResult.status !== "found") {
      logger.warn(`${LOG} filed run's Project unresolved`, { workspaceId, runId, errorCategory: projectResult.status });
    }
  }

  // ── The list itself ──
  // E2A-S7: authority was settled entirely above, from the CURRENT caller's
  // Workspace standing. Nothing below consults `createdBy`; it is projected as
  // metadata only, so a current reader who created none of these exports sees
  // them, and a removed creator sees nothing because they never get here.
  const listResult = await listAdaptiveExportRecords(runId, { limit, beforeReportVersion });
  if (!listResult.ok) {
    // R1 normalised this to 503 (one condition, one contract). R2 P3-1/§28 then
    // found the 500 `list_failed` fallback it left behind was DEAD BY TYPE:
    // `ListAdaptiveExportsResult`'s failure arm is exactly
    // `{ reason: "firestore_unavailable" | "read_failed" }`, so once both are
    // handled `reason` narrows to `never`. The comment claiming "an unexpected
    // reason still falls through to 500" described a branch no in-type value can
    // reach, and the test that "proved" it could only do so by making an untyped
    // mock return a reason production cannot produce. Both are gone: a future
    // added reason now breaks the BUILD here instead of being silently laundered
    // into 503, which is the property the dead branch only pretended to give.
    //
    // `read_failed` is the only reason reachable from THIS route —
    // `firestore_unavailable` is returned solely when the helper sees
    // `!adminDb`, which the guard near the top of GET already answered. It is
    // handled because it is in the union, not because it can arrive.
    switch (listResult.reason) {
      case "firestore_unavailable":
      case "read_failed":
        logger.warn(`${LOG} export history read failed`, { workspaceId, runId, errorCategory: listResult.reason });
        return shared(unavailableAfterAuthorization());
      default: {
        const unhandledReason: never = listResult.reason;
        throw new Error(`Unhandled export-history failure reason: ${String(unhandledReason)}`);
      }
    }
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
    // BLIND_CAST_HARDENING. `exportMetadata` is declared required on
    // `AdaptiveResearchExportV1`, but nothing validates it at runtime:
    // `normalizeAdaptiveExportRecord` returns `raw as AdaptiveResearchExportV1`
    // with no shape check, so the type is an assumption about persisted data,
    // not a guarantee about it. Unguarded, `r.exportMetadata.fileHash` threw a
    // TypeError out of GET — the one failure path with no `{ok:false,errorCode}`
    // envelope — and a single malformed document would break the whole page for
    // every reader. The record still lists; only its hash trio is omitted, which
    // is already the contract for a record that produced no bytes, and no hash
    // value is ever synthesized.
    //
    // SUPERSEDED CLAIM, recorded deliberately. An earlier revision of this
    // comment (and of commit 8a5ef05d's message, which is left intact for
    // auditability) asserted this shape was "REACHABLE from historical data":
    // that a legacy document whose only hash carrier was the flat
    // `"exportMetadata.fileHash"` key would arrive with no `exportMetadata`.
    // R3 source-traced it and that is FALSE. The pre-fix
    // `markAdaptiveExportReady` wrote the flat key via
    // `.set({ "exportMetadata.fileHash": hash }, { merge: true })` onto a
    // document `createAdaptiveExportRecord` had ALREADY written with a full
    // nested `exportMetadata` (the flat-key bug is commit 86185a6; the create
    // writer has existed since fe1891f). Legacy records therefore carry BOTH,
    // and `normalizeAdaptiveExportRecord` merges the flat value in and strips
    // the key. NO writer in this repository has been demonstrated to produce a
    // record lacking `exportMetadata`. The guard is justified by the blind cast
    // at a public API boundary, not by a known producer.
    ...(r.exportMetadata?.fileHash
      ? { fileHash: r.exportMetadata.fileHash, hashAlgorithm: "sha256" as const, hashReproducible: isHashReproducible(r.format) }
      : {}),
  }));

  // ── E2A-S15: a paging envelope is never self-contradictory ──
  // R3 reproduced the trap: a record whose `reportVersion` is missing or
  // non-numeric (this route reads blind-cast historical persistence, so it
  // cannot assume otherwise) produced `hasMore: true` with `nextCursor`
  // ABSENT — `JSON.stringify` drops `undefined`, which also violated this
  // route's own envelope allow-list — and a client paging on `nextCursor`
  // re-requests page 1 for ever.
  //
  // The two tempting repairs are both lies: `hasMore: false` would claim the
  // history is complete when it is not, and synthesizing a cursor would invent
  // a position in someone's audit history. So a page that cannot yield a valid
  // continuation is treated as what it is — malformed persisted data — and
  // answered with this route's existing service-unavailable envelope. No new
  // public error vocabulary, and the caller is told to retry rather than handed
  // a contradiction.
  const lastReportVersion = items.length > 0 ? items[items.length - 1].reportVersion : null;
  const nextCursor = listResult.hasMore && typeof lastReportVersion === "number" && Number.isFinite(lastReportVersion) ? lastReportVersion : null;
  if (listResult.hasMore && nextCursor === null) {
    logger.warn(`${LOG} export history page cannot yield a continuation cursor`, {
      workspaceId,
      runId,
      itemCount: items.length,
      lastReportVersionType: typeof lastReportVersion,
    });
    return shared(unavailableAfterAuthorization());
  }

  return NextResponse.json({ ok: true, runId, exports: items, hasMore: listResult.hasMore, nextCursor });
}
