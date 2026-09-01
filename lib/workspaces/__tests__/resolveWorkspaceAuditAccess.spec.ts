/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — `resolveWorkspaceAuditAccess()`
 * tests. Structural mirror of `resolveTeamRunWorkspaceAccess.spec.ts` —
 * mocks `@/lib/env` and `resolveWorkspaceAccess()` directly.
 */

let teamWorkspacesEnabled = true;
let teamWorkspacesCanaryUids: string | undefined = undefined;
let teamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
  },
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return teamWorkspacesCanaryWorkspaceIds;
  },
}));

const mockResolveWorkspaceAccess = jest.fn();
jest.mock("../resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: unknown[]) => mockResolveWorkspaceAccess(...args),
}));

import { Timestamp } from "firebase-admin/firestore";
import { resolveWorkspaceAuditAccess } from "../resolveWorkspaceAuditAccess";
import type { TeamWorkspaceV1 } from "../types";
import type { WorkspaceMembershipV1, WorkspaceMembershipRole } from "../membershipTypes";

const NOW = Timestamp.now();
const UID = "uid-1";
const WS_ID = "ws-team-1";

function teamWorkspace(overrides: Partial<TeamWorkspaceV1> = {}): TeamWorkspaceV1 {
  return { schemaVersion: 1, id: WS_ID, type: "team", name: "Team", ownerUserId: UID, createdByUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function membership(role: WorkspaceMembershipRole, overrides: Partial<WorkspaceMembershipV1> = {}): WorkspaceMembershipV1 {
  return { schemaVersion: 1, id: "wm_x", workspaceId: WS_ID, uid: UID, role, status: "active", invitedByUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides } as WorkspaceMembershipV1;
}

beforeEach(() => {
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
  mockResolveWorkspaceAccess.mockReset();
});

describe("resolveWorkspaceAuditAccess — rollout-first ordering", () => {
  it("A. rollout globally disabled, uid not canaried: team_workspaces_disabled, zero Workspace reads", async () => {
    teamWorkspacesEnabled = false;
    const result = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "team_workspaces_disabled" });
    expect(mockResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("B. rollout disabled globally but uid canaried: admitted, resolveWorkspaceAccess called exactly once", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = UID;
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("owner"), capabilities: ["audit.read"] });
    const result = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(result.granted).toBe(true);
    expect(mockResolveWorkspaceAccess).toHaveBeenCalledTimes(1);
  });
});

describe("resolveWorkspaceAuditAccess — Team-type guard / Personal-Workspace collision", () => {
  it("C. resolveWorkspaceAccess grants Personal -> mapped to wrong_workspace_type", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({
      granted: true,
      workspaceType: "personal",
      workspace: { schemaVersion: 1, id: "personal-B", type: "personal", name: "B's Workspace", ownerUserId: "B", createdAt: NOW, updatedAt: NOW },
    });
    const result = await resolveWorkspaceAuditAccess({ uid: "B", workspaceId: "personal-B" });
    expect(result).toEqual({ granted: false, reason: "wrong_workspace_type" });
  });

  it("D. resolveWorkspaceAccess denies with 'not_owner' -> mapped to wrong_workspace_type", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "not_owner" });
    const result = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: "personal-someone-else" });
    expect(result).toEqual({ granted: false, reason: "wrong_workspace_type" });
  });
});

describe("resolveWorkspaceAuditAccess — authorization matrix", () => {
  it("E. Workspace absent -> workspace_not_found", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "workspace_not_found" });
  });

  it("F. Workspace malformed -> workspace_malformed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_malformed" });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "workspace_malformed" });
  });

  it("G. membership absent -> membership_not_found", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "membership_not_found" });
  });

  it("H. removed former member (including former Admin/Owner) -> membership_removed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "membership_removed" });
  });

  it("I. membership malformed -> membership_malformed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_malformed" });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "membership_malformed" });
  });

  it("J. owner integrity violation -> owner_integrity_violation", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "owner_integrity_violation" });
  });

  it("K. underlying lookup failure -> lookup_failed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "lookup_failed" });
  });

  it("L. Owner: resolver grants, capabilities include audit.read (route enforces the specific capability, not this resolver)", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("owner"), capabilities: ["audit.read", "workspace.read"] });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r.granted).toBe(true);
    if (r.granted) expect(r.capabilities).toContain("audit.read");
  });

  it("M. Member: resolver still grants (capability array simply lacks audit.read) — capability enforcement is the ROUTE's job", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["workspace.read"] });
    const r = await resolveWorkspaceAuditAccess({ uid: UID, workspaceId: WS_ID });
    expect(r.granted).toBe(true);
    if (r.granted) expect(r.capabilities).not.toContain("audit.read");
  });

  it("N. no import from lib/governance/ — architecturally independent of the legacy /governance authorization model", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "lib/workspaces/resolveWorkspaceAuditAccess.ts"), "utf8");
    const importLines = source.split("\n").filter((line: string) => /^import /.test(line.trim()));
    for (const line of importLines) {
      expect(line).not.toMatch(/lib\/governance\//);
    }
  });
});
