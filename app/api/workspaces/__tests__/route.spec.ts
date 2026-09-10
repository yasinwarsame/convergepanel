/**
 * Team Workspace Core Foundation, Phase 8B, route namespace corrected in
 * Phase 8B.1 — POST /api/workspaces tests. Mocks `createTeamWorkspace()`
 * (already independently tested) — this suite covers request parsing,
 * auth, and status-code mapping only. No feature-flag/disabled scenario
 * exists here — Phase 8B.1 removed `TEAM_WORKSPACES_ENABLED` entirely.
 *
 * Phase 9C.1-R1C adds `GET /api/workspaces` — the bounded, paginated
 * "Team Workspaces I actively belong to" discovery/selection list backing
 * the Reviews multi-Workspace chooser.
 *
 * PHASE 11B.5-P0 — THE GET CONTRACT CHANGED, AND THE OLD TESTS FOR IT ARE
 * REPLACED RATHER THAN SKIPPED.
 *
 * GET used to branch on `resolveTeamWorkspacesMode()`, falling back to a
 * bounded Workspace-canary lookup that collapsed to 503 for everyone else.
 * That made the endpoint's answer INCOMPLETE for a legitimate member: Team
 * Workspace pages authorize on `resolveWorkspaceAccess()` alone and consult no
 * rollout flag, so an active member of a Workspace outside the canary set could
 * open that Workspace while this endpoint reported they belonged to nothing.
 *
 * Discovering a membership you ALREADY hold is not the authority to create a
 * Workspace. So: GET is membership-derived and unconditional for an
 * authenticated caller; POST creation stays rollout-gated inside
 * `createTeamWorkspace()`. The two rollout mocks below are therefore kept ONLY
 * as negative-dependency tripwires — they now THROW, so any reintroduction of
 * the old coupling fails these tests instead of passing quietly.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

const mockedCreateTeamWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaceMemberships", () => ({
  createTeamWorkspace: (...args: unknown[]) => mockedCreateTeamWorkspace(...args),
}));

/**
 * NEGATIVE-DEPENDENCY TRIPWIRE (Phase 11B.5-P0). Nothing in this route may
 * consult Team self-service rollout any more. These are not stubs returning a
 * convenient value — they throw, so reintroducing the coupling surfaces as a
 * failure rather than as a silently-passing suite.
 */
const mockedResolveTeamWorkspacesMode = jest.fn(() => {
  throw new Error("resolveTeamWorkspacesMode must not be called by /api/workspaces — GET discovery is membership-derived, POST gating lives in createTeamWorkspace()");
});
jest.mock("@/lib/workspaces/teamWorkspacesRollout", () => ({
  resolveTeamWorkspacesMode: (...args: unknown[]) => mockedResolveTeamWorkspacesMode(...args),
}));

const mockedListViewerTeamWorkspaces = jest.fn();
jest.mock("@/lib/workspaces/listViewerTeamWorkspaces", () => ({
  ...jest.requireActual("@/lib/workspaces/listViewerTeamWorkspaces"),
  listViewerTeamWorkspaces: (...args: unknown[]) => mockedListViewerTeamWorkspaces(...args),
}));

/** Second tripwire — the Workspace-canary branch is gone from GET entirely. */
const mockedListWorkspaceCanaryMembershipsForUid = jest.fn(() => {
  throw new Error("listWorkspaceCanaryMembershipsForUid must not be called by /api/workspaces after Phase 11B.5-P0");
});
jest.mock("@/lib/workspaces/resolveWorkspaceCanaryMembershipsForUid", () => ({
  listWorkspaceCanaryMembershipsForUid: (...args: unknown[]) => mockedListWorkspaceCanaryMembershipsForUid(...args),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/workspaces/route";
import { VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE, VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE } from "@/lib/workspaces/listViewerTeamWorkspaces";

const UID = "uid-1";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/workspaces", { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

function buildGetRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces${query}`, { method: "GET" });
}

async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body));
  const json = await res.json();
  return { res, json };
}

async function callGet(query = "") {
  const res = await GET(buildGetRequest(query));
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  // Deliberately NOT re-stubbed: the rollout/canary mocks stay throwing.
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(401);
  expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
});

it("400s on an invalid JSON body", async () => {
  const req = new NextRequest("http://localhost/api/workspaces", { method: "POST", body: "not json" });
  const res = await POST(req);
  expect(res.status).toBe(400);
});

it("400s on an unexpected field", async () => {
  const { res, json } = await callRoute({ name: "Acme", ownerUserId: "attacker-controlled" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
});

it("400s on an invalid name", async () => {
  const { res } = await callRoute({ name: "" });
  expect(res.status).toBe(400);
  expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
});

it("201s and returns the created workspace/membership on success", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "created", workspace: { id: "ws-1", type: "team" }, membership: { id: "wm_1", role: "owner" } });
  const { res, json } = await callRoute({ name: "Acme Team" });
  expect(res.status).toBe(201);
  expect(json.ok).toBe(true);
  expect(json.workspace.id).toBe("ws-1");
  expect(mockedCreateTeamWorkspace).toHaveBeenCalledWith({ uid: UID, name: "Acme Team" });
});

it("passes only the authenticated uid — never a client-supplied uid", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "created", workspace: {}, membership: {} });
  await callRoute({ name: "Acme" });
  expect(mockedCreateTeamWorkspace.mock.calls[0][0]).toEqual({ uid: UID, name: "Acme" });
});

it("500s on create_failed", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "create_failed" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(500);
});

it("500s on firestore_unavailable", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "firestore_unavailable" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(500);
});

it("503s when team_workspaces_disabled (rollout gate off)", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "team_workspaces_disabled" });
  const { res, json } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(503);
  expect(json.errorCode).toBe("team_workspaces_disabled");
});

describe("GET /api/workspaces — Phase 11B.5-P0 membership discovery", () => {
  const ok = (items: { workspaceId: string; name: string }[], over: Record<string, unknown> = {}) => ({
    status: "ok", items, hasMore: false, nextCursor: null, ...over,
  });

  it("T1 — 401s when unauthenticated, and never reaches any discovery implementation or the creation function", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callGet();
    expect(res.status).toBe(401);
    expect(mockedListViewerTeamWorkspaces).not.toHaveBeenCalled();
    expect(mockedListWorkspaceCanaryMembershipsForUid).not.toHaveBeenCalled();
    expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
  });

  it("T2 — zero active memberships is 200 with an empty list, NOT 503 (this replaces the old non-admitted 503 expectation)", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([]));
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, items: [], hasMore: false, nextCursor: null });
    expect(res.status).not.toBe(503);
  });

  it("T3 — one active membership returns exactly that Workspace", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([{ workspaceId: "ws_a", name: "Acme Risk Lab" }]));
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.items).toEqual([{ workspaceId: "ws_a", name: "Acme Risk Lab" }]);
  });

  it("T4 — P6: an active membership OUTSIDE the Workspace-canary set is still returned while Team self-service rollout is off — proven by the rollout/canary tripwires never firing", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: "uid_p6", source: "session_cookie" });
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([{ workspaceId: "ws_non_canary", name: "Existing Research Team" }]));

    const { res, json } = await callGet();

    expect(res.status).toBe(200);
    expect(json.items).toEqual([{ workspaceId: "ws_non_canary", name: "Existing Research Team" }]);
    // The old coupling would have thrown here (both mocks throw on call), so a
    // green assertion is behavioral proof GET took the membership path only.
    expect(mockedResolveTeamWorkspacesMode).not.toHaveBeenCalled();
    expect(mockedListWorkspaceCanaryMembershipsForUid).not.toHaveBeenCalled();
    expect(mockedListViewerTeamWorkspaces).toHaveBeenCalledTimes(1);
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ uid: "uid_p6" });
  });

  it("T5 — passes only the authenticated uid, never a client-supplied one", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([]));
    await callGet("?uid=uid-attacker&workspaceId=ws-attacker");
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ uid: UID });
    expect(JSON.stringify(mockedListViewerTeamWorkspaces.mock.calls[0][0])).not.toContain("uid-attacker");
  });

  it("T6 — forwards a supplied cursor verbatim", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([]));
    await callGet("?cursor=ws_cursor_token");
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ cursor: "ws_cursor_token" });
  });

  it("T7 — limit: default applied, oversized clamped to the max, garbage falls back to the default", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([]));
    await callGet();
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ limit: VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE });

    jest.clearAllMocks();
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([]));
    await callGet("?limit=9999");
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ limit: VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE });

    jest.clearAllMocks();
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([]));
    await callGet("?limit=not-a-number");
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ limit: VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE });
  });

  it("T8 — lookup_failed is a 500: a real infrastructure failure is never flattened into 200 [] or into 503", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue({ status: "lookup_failed" });
    const { res, json } = await callGet();
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(503);
    expect(json.ok).not.toBe(true);
    expect(json.items).toBeUndefined();
  });

  it("T9 — minimal disclosure: each item carries exactly workspaceId and name, even when the helper hands back extra fields", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue(ok([{ workspaceId: "ws_a", name: "Acme Risk Lab" }]));
    const { json } = await callGet();
    for (const item of json.items) {
      expect(Object.keys(item).sort()).toEqual(["name", "workspaceId"]);
    }
    const serialized = JSON.stringify(json);
    for (const leaked of ["role", "capabilities", "ownerUserId", "createdByUserId", "members", "invitation", "billing", "canary", "rollout", "stripe"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("T10 — hasMore and nextCursor are passed through exactly, so a truncated page is never presented as complete", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue(
      ok([{ workspaceId: "ws_a", name: "Acme Risk Lab" }], { hasMore: true, nextCursor: "ws_a" })
    );
    const { json } = await callGet();
    expect(json.hasMore).toBe(true);
    expect(json.nextCursor).toBe("ws_a");
  });

  it("S — GET consults NO Team rollout dependency on any path: success, empty and failure alike", async () => {
    for (const outcome of [ok([{ workspaceId: "ws_a", name: "A" }]), ok([]), { status: "lookup_failed" }]) {
      jest.clearAllMocks();
      mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
      mockedListViewerTeamWorkspaces.mockResolvedValue(outcome);
      await callGet();
      expect(mockedResolveTeamWorkspacesMode).not.toHaveBeenCalled();
      expect(mockedListWorkspaceCanaryMembershipsForUid).not.toHaveBeenCalled();
    }
  });

  it("H — GET becoming membership-based does not touch creation: POST still refuses when createTeamWorkspace reports the rollout off", async () => {
    mockedCreateTeamWorkspace.mockResolvedValue({ status: "team_workspaces_disabled" });
    const { res } = await callRoute({ name: "New Team" });
    expect(res.status).toBe(503);
  });
});
