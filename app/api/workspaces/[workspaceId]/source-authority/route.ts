/**
 * Order 4 Slice 2a — `GET|POST /api/workspaces/{workspaceId}/source-authority`.
 * Dark management surface for Workspace Source Standing (no UI consumes it).
 *
 * Order (each step only after every earlier one passes):
 *   1. authenticate;
 *   2. Team Workspace admission (`resolveWorkspaceAuditAccess` — concealed denials);
 *   3. `sources.attest` — Owner/Admin only, via the central capability table;
 *   4. release flag `SOURCE_AUTHORITY_METADATA_ENABLED` — concealed (404) until
 *      2–3 pass, so an unauthorized caller cannot observe feature state; while
 *      off, ZERO Source Standing reads or writes;
 *   5. strict validation (unknown or server-owned fields are rejected, never
 *      ignored), then the read or the single transactional write. The write
 *      re-authorizes `sources.attest` inside its own transaction.
 *
 * GET  ?url=<cited URL>  → the Workspace's current standing for that exact document.
 * POST { url, operation, reasonCode, successorUrl?, expectedRevision }
 *      expectedRevision: null = "create from absent"; an integer = the exact
 *      current revision being replaced. A mismatch is a 409 — never retried here.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { SOURCE_AUTHORITY_METADATA_ENABLED } from "@/lib/env";
import { resolveWorkspaceAuditAccess } from "@/lib/workspaces/resolveWorkspaceAuditAccess";
import { teamAuditAccessDeniedResponse, teamAuditWorkspaceNotFoundConcealedResponse } from "@/lib/workspaces/teamAuditAccessResponse";
import { internalErrorResponse, invalidRequestBodyResponse, unexpectedFieldResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { sourceIdentityV1, type SourceIdentityV1 } from "@/lib/sourceStanding/sourceIdentity";
import { isReasonAllowed, isSourceStandingOperation, statusForOperation, type SourceStandingOperation, type SourceStandingReasonCode } from "@/lib/sourceStanding/standingTypes";
import { applySourceStandingOperation, readStandingForManagement, type ApplyStandingResult, type ManagementStanding } from "@/lib/sourceStanding/standingFirestore";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/workspaces/[workspaceId]/source-authority";
const MAX_BODY_CHARS = 8192;
const BODY_KEYS: readonly string[] = ["url", "operation", "reasonCode", "successorUrl", "expectedRevision"];

type Gate = { ok: true; uid: string; workspaceId: string } | { ok: false; response: NextResponse };

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

function sourceAuthorityForbidden(): NextResponse {
  return json(403, { ok: false, errorCode: "insufficient_capability", message: "You do not have permission to manage source standing in this Workspace." });
}

async function gate(req: NextRequest, method: "GET" | "POST", workspaceId: string): Promise<Gate> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: `${method} ${ROUTE}`, method, failureCategory: identity.reason });
    return {
      ok: false,
      response:
        identity.reason === "missing_credentials"
          ? json(401, { ok: false, errorCode: "unauthorized", message: "Please sign in." })
          : json(401, { ok: false, errorCode: "auth_error", message: "Authentication failed." }),
    };
  }
  const access = await resolveWorkspaceAuditAccess({ uid: identity.uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamAuditAccessDeniedResponse(access.reason);
    return { ok: false, response: json(status, body) };
  }
  if (!access.capabilities.includes("sources.attest")) return { ok: false, response: sourceAuthorityForbidden() };
  if (!SOURCE_AUTHORITY_METADATA_ENABLED || !adminDb) {
    const { status, body } = teamAuditWorkspaceNotFoundConcealedResponse();
    return { ok: false, response: json(status, body) };
  }
  return { ok: true, uid: identity.uid, workspaceId };
}

function invalidUrl(field: "url" | "successorUrl"): NextResponse {
  return json(400, { ok: false, errorCode: "SOURCE_AUTHORITY_INVALID_URL", field, message: "The URL is not an acceptable public document URL." });
}

function toManagementDto(identity: SourceIdentityV1, standing: ManagementStanding) {
  const source = { canonicalUrl: identity.canonicalUrl, idHash: identity.idHash };
  if (standing.kind === "absent") return { ok: true, source, standing: null };
  if (standing.kind === "unresolved") return { ok: true, source, standing: { status: "UNRESOLVED" } };
  return {
    ok: true,
    source,
    standing: {
      status: standing.status,
      reasonCode: standing.reasonCode,
      revision: standing.revision,
      asOf: standing.asOf,
      ...(standing.successor ? { successor: standing.successor.resolved ? { status: "RESOLVED", url: standing.successor.url } : { status: "UNRESOLVED" } } : {}),
    },
  };
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const g = await gate(req, "GET", params.workspaceId);
  if (!g.ok) return g.response;

  const keys = Array.from(new Set(Array.from(req.nextUrl.searchParams.keys())));
  if (keys.some((k) => k !== "url")) {
    const { status, body } = unexpectedFieldResponse();
    return json(status, body);
  }
  const values = req.nextUrl.searchParams.getAll("url");
  if (values.length !== 1) {
    const { status, body } = invalidRequestBodyResponse();
    return json(status, body);
  }
  const identity = sourceIdentityV1(values[0]);
  if (!identity) return invalidUrl("url");

  try {
    return json(200, toManagementDto(identity, await readStandingForManagement(g.workspaceId, identity)));
  } catch (err: unknown) {
    logger.error("[api/workspaces/source-authority] read failed", { workspaceId: g.workspaceId, idHash: identity.idHash, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = internalErrorResponse();
    return json(status, body);
  }
}

type ParsedBody = {
  identity: SourceIdentityV1;
  operation: SourceStandingOperation;
  reasonCode: SourceStandingReasonCode;
  successorIdentity: SourceIdentityV1 | null;
  expectedRevision: number | null;
};

function parseBody(raw: unknown): { ok: true; body: ParsedBody } | { ok: false; response: NextResponse } {
  const invalid = () => {
    const { status, body } = invalidRequestBodyResponse();
    return { ok: false as const, response: json(status, body) };
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid();
  const o = raw as Record<string, unknown>;
  // Server-owned fields (status, workspaceId, actor, updatedAt, schemaVersion, identity, idHash …) are rejected like any unknown key.
  if (Object.keys(o).some((k) => !BODY_KEYS.includes(k))) {
    const { status, body } = unexpectedFieldResponse();
    return { ok: false, response: json(status, body) };
  }
  const own = (k: string) => Object.prototype.hasOwnProperty.call(o, k);
  if (!isSourceStandingOperation(o.operation)) return invalid();
  const operation = o.operation;
  const toStatus = statusForOperation(operation);
  if (!isReasonAllowed(toStatus, o.reasonCode)) return invalid();
  if (!own("expectedRevision")) return invalid();
  const er = o.expectedRevision;
  if (er !== null && !(typeof er === "number" && Number.isSafeInteger(er) && er >= 1)) return invalid();
  // WITHDRAWN deletes an existing record, so it always names the revision it withdraws.
  if (operation === "withdraw" && er === null) return invalid();

  const identity = sourceIdentityV1(o.url);
  if (!identity) return { ok: false, response: invalidUrl("url") };

  let successorIdentity: SourceIdentityV1 | null = null;
  if (operation === "supersede") {
    if (!own("successorUrl")) return invalid();
    successorIdentity = sourceIdentityV1(o.successorUrl);
    if (!successorIdentity) return { ok: false, response: invalidUrl("successorUrl") };
  } else if (own("successorUrl")) {
    return invalid();
  }
  return { ok: true, body: { identity, operation, reasonCode: o.reasonCode, successorIdentity, expectedRevision: er } };
}

function mutationResponse(result: ApplyStandingResult): NextResponse {
  if (result.ok) return json(200, { ok: true, status: result.status, revision: result.revision });
  switch (result.reason) {
    case "denied":
      if (result.denial === "insufficient_capability") return sourceAuthorityForbidden();
      // Membership/Workspace changed between the precheck and the transaction — same concealment as the precheck.
      return json(404, teamAuditWorkspaceNotFoundConcealedResponse().body);
    case "revision_conflict":
      return json(409, { ok: false, errorCode: "SOURCE_AUTHORITY_REVISION_CONFLICT", message: "This source's standing changed since you last loaded it. Reload and try again." });
    case "current_unresolved":
    case "history_unresolved":
      return json(409, { ok: false, errorCode: "SOURCE_AUTHORITY_STATE_UNRESOLVED", message: "This source's stored standing could not be read safely, so it cannot be changed." });
    case "successor_invalid":
      return json(409, { ok: false, errorCode: "SOURCE_AUTHORITY_SUCCESSOR_INVALID", reason: result.detail, message: "The successor must be a different document with a valid standing in this Workspace, and the chain must end within 8 steps without a cycle." });
    case "nothing_to_withdraw":
    case "invalid_operation": {
      const { status, body } = invalidRequestBodyResponse();
      return json(status, body);
    }
  }
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const g = await gate(req, "POST", params.workspaceId);
  if (!g.ok) return g.response;

  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) {
      const { status, body } = invalidRequestBodyResponse();
      return json(status, body);
    }
    raw = JSON.parse(text);
  } catch {
    const { status, body } = invalidRequestBodyResponse();
    return json(status, body);
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await applySourceStandingOperation({ workspaceId: g.workspaceId, uid: g.uid, ...parsed.body });
    if (result.ok) {
      logger.info("[api/workspaces/source-authority] standing changed", { workspaceId: g.workspaceId, idHash: parsed.body.identity.idHash, status: result.status, revision: result.revision });
    }
    return mutationResponse(result);
  } catch (err: unknown) {
    logger.error("[api/workspaces/source-authority] write failed", { workspaceId: g.workspaceId, idHash: parsed.body.identity.idHash, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = internalErrorResponse();
    return json(status, body);
  }
}
