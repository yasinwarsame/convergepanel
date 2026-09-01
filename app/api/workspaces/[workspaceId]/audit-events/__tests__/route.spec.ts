/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — GET
 * /api/workspaces/{workspaceId}/audit-events tests. Mocks
 * resolveWorkspaceAuditAccess() and listWorkspaceAuditEvents() (each
 * independently tested elsewhere) — this suite covers auth, gate order,
 * capability enforcement, status-code mapping, limit clamping, and cursor
 * pass-through only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedResolveWorkspaceAuditAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAuditAccess", () => ({
  resolveWorkspaceAuditAccess: (...args: unknown[]) => mockedResolveWorkspaceAuditAccess(...args),
}));

const mockedListWorkspaceAuditEvents = jest.fn();
jest.mock("@/lib/workspaces/listWorkspaceAuditEvents", () => ({
  listWorkspaceAuditEvents: (...args: unknown[]) => mockedListWorkspaceAuditEvents(...args),
  AUDIT_LOG_DEFAULT_LIMIT: 20,
  AUDIT_LOG_MAX_LIMIT: 50,
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/audit-events/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";

function buildRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/audit-events${query}`, { method: "GET" });
}
async function callRoute(query = "") {
  const res = await GET(buildRequest(query), { params: { workspaceId: WS_ID } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

describe("authentication (A)", () => {
  it("401s when unauthenticated, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callRoute();
    expect(res.status).toBe(401);
    expect(mockedResolveWorkspaceAuditAccess).not.toHaveBeenCalled();
    expect(mockedListWorkspaceAuditEvents).not.toHaveBeenCalled();
  });
});

describe("access denial mapping (B, H, I, J)", () => {
  it("team_workspaces_disabled -> concealed 404 (read-route convention)", async () => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: false, reason: "team_workspaces_disabled" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
  });

  it("non-member (membership_not_found) -> concealed 404, indistinguishable from disabled", async () => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
  });

  it("removed former Admin (membership_removed) -> concealed 404", async () => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const { res } = await callRoute();
    expect(res.status).toBe(404);
  });

  it("foreign Workspace type collision (wrong_workspace_type) -> same concealed 404", async () => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: false, reason: "wrong_workspace_type" });
    const { res } = await callRoute();
    expect(res.status).toBe(404);
  });

  it("lookup_failed -> distinct 503, not concealed as 404 (infra failure is not evidence about access state)", async () => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("team_workspace_unavailable");
  });
});

describe("capability enforcement (E, F, G)", () => {
  it("granted but capabilities lack audit.read (Member/Reviewer/Viewer) -> 403 insufficient_capability, listWorkspaceAuditEvents never called", async () => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: true, capabilities: ["workspace.read", "projects.read"] });
    const { res, json } = await callRoute();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("insufficient_capability");
    expect(mockedListWorkspaceAuditEvents).not.toHaveBeenCalled();
  });

  it("granted with audit.read (Owner/Admin) -> proceeds to the read model", async () => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: true, capabilities: ["audit.read"] });
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const { res } = await callRoute();
    expect(res.status).toBe(200);
    expect(mockedListWorkspaceAuditEvents).toHaveBeenCalledTimes(1);
  });
});

describe("read model wiring / bounds (L, M, N)", () => {
  beforeEach(() => {
    mockedResolveWorkspaceAuditAccess.mockResolvedValue({ granted: true, capabilities: ["audit.read"] });
  });

  it("no limit query param -> default limit 20 forwarded", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await callRoute();
    expect(mockedListWorkspaceAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("limit above max clamps to 50", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await callRoute("?limit=9999");
    expect(mockedListWorkspaceAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("limit=0 falls back to the default (matches the identical `parseInt(...) || DEFAULT` convention established in app/api/workspaces/[workspaceId]/runs/route.ts — 0 is falsy in JS, so it triggers the same default fallback there too, not a bug introduced here)", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await callRoute("?limit=0");
    expect(mockedListWorkspaceAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("negative limit clamps to 1", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await callRoute("?limit=-5");
    expect(mockedListWorkspaceAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it("cursor query param is passed through opaquely", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await callRoute("?cursor=abc123");
    expect(mockedListWorkspaceAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ cursorRaw: "abc123" }));
  });

  it("invalid_cursor -> 400", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "invalid_cursor" });
    const { res, json } = await callRoute("?cursor=garbage");
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_cursor");
  });

  it("query_failed -> 500 generic internal error, never a raw exception", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "query_failed" });
    const { res } = await callRoute();
    expect(res.status).toBe(500);
  });

  it("ok result: response echoes events/hasMore/nextCursor from the read model", async () => {
    mockedListWorkspaceAuditEvents.mockResolvedValue({ status: "ok", items: [{ eventType: "workspace_member_removed" }], hasMore: true, nextCursor: "next-abc" });
    const { json } = await callRoute();
    expect(json.ok).toBe(true);
    expect(json.events).toHaveLength(1);
    expect(json.hasMore).toBe(true);
    expect(json.nextCursor).toBe("next-abc");
  });
});

describe("no legacy governance dependency (plan-gate regression, AD)", () => {
  it("route source imports nothing from lib/governance/", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/workspaces/[workspaceId]/audit-events/route.ts"), "utf8");
    const importLines = source.split("\n").filter((line: string) => /^import /.test(line.trim()));
    for (const line of importLines) {
      expect(line).not.toMatch(/lib\/governance\//);
    }
    expect(source).not.toMatch(/plan_required/);
  });
});
