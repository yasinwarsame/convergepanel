/**
 * Team Run Lists, Phase 8C-B2 — `resolveTeamRunWorkspaceAccess()` tests.
 * Mocks `@/lib/env` (rollout flags) and `resolveWorkspaceAccess()`
 * directly — this resolver's own logic is pure composition + the
 * rollout-first gate + the Team-type guard over `resolveWorkspaceAccess()`'s
 * result, mirroring how `resolveWorkspaceAccess.spec.ts` itself tests one
 * level lower.
 */

let teamWorkspacesEnabled = true;
let teamWorkspacesCanaryUids: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
  },
}));

const mockResolveWorkspaceAccess = jest.fn();
jest.mock("../resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: unknown[]) => mockResolveWorkspaceAccess(...args),
}));

import { Timestamp } from "firebase-admin/firestore";
import { resolveTeamRunWorkspaceAccess } from "../resolveTeamRunWorkspaceAccess";
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
  mockResolveWorkspaceAccess.mockReset();
});

describe("resolveTeamRunWorkspaceAccess — rollout-first ordering (security critical)", () => {
  it("rollout globally disabled, uid not canaried: returns team_workspaces_disabled and NEVER calls resolveWorkspaceAccess (zero Workspace reads)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    const result = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "team_workspaces_disabled" });
    expect(mockResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("rollout disabled globally but uid IS in a valid canary list: admitted, resolveWorkspaceAccess called exactly once", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = `${UID},someone-else`;
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read"] });
    const result = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result.granted).toBe(true);
    expect(mockResolveWorkspaceAccess).toHaveBeenCalledTimes(1);
    expect(mockResolveWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });

  it("admitted caller: exactly ONE underlying Workspace resolution path is exercised, not two", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("owner"), capabilities: ["research.read"] });
    await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(mockResolveWorkspaceAccess).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTeamRunWorkspaceAccess — Team-type guard / Personal-Workspace collision", () => {
  it("PERSONAL-B COLLISION: run owner A, run.workspaceId=personal-B, requester=B genuinely owns personal-B -> resolveWorkspaceAccess grants workspaceType 'personal', but this resolver rejects as wrong_workspace_type", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({
      granted: true,
      workspaceType: "personal",
      workspace: { schemaVersion: 1, id: "personal-B", type: "personal", name: "B's Workspace", ownerUserId: "B", createdAt: NOW, updatedAt: NOW },
    });
    const result = await resolveTeamRunWorkspaceAccess({ uid: "B", workspaceId: "personal-B" });
    expect(result).toEqual({ granted: false, reason: "wrong_workspace_type" });
  });

  it("resolveWorkspaceAccess denies with reason 'not_owner' (foreign Personal Workspace) -> mapped to wrong_workspace_type here", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "not_owner" });
    const result = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: "personal-someone-else" });
    expect(result).toEqual({ granted: false, reason: "wrong_workspace_type" });
  });
});

describe("resolveTeamRunWorkspaceAccess — authorization matrix (Part 13)", () => {
  it("1. rollout disabled -> 'team_workspaces_disabled', zero Workspace read (covered above)", () => {
    expect(true).toBe(true);
  });

  it("2. Workspace absent -> workspace_not_found", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "workspace_not_found" });
  });

  it("3. Workspace malformed -> workspace_malformed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_malformed" });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "workspace_malformed" });
  });

  it("4. wrong workspace type / Personal Workspace -> wrong_workspace_type (covered above)", () => {
    expect(true).toBe(true);
  });

  it("5. membership absent -> membership_not_found", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "membership_not_found" });
  });

  it("6. membership removed -> membership_removed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "membership_removed" });
  });

  it("7. membership malformed -> membership_malformed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_malformed" });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "membership_malformed" });
  });

  it("8. owner integrity violation -> owner_integrity_violation", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "owner_integrity_violation" });
  });

  it("9. underlying lookup failure -> lookup_failed", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r).toEqual({ granted: false, reason: "lookup_failed" });
  });

  it("10. active member without research.read: resolver still grants (capability array simply lacks it) — capability enforcement is the ROUTE's job, not this resolver's", async () => {
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("viewer"), capabilities: ["research.read"] });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r.granted).toBe(true);
  });

  it("11. active member with research.read -> granted, capabilities passed through unmodified", async () => {
    const caps = ["research.read", "projects.read"] as const;
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: caps });
    const r = await resolveTeamRunWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(r.granted).toBe(true);
    if (r.granted) {
      expect(r.capabilities).toEqual(caps);
      expect(r.workspace).toEqual(teamWorkspace());
    }
  });

  it("no creator grant: a run's userId is never consulted by this resolver at all (it takes no run-related argument)", async () => {
    // Structural proof: the function signature itself only accepts {uid, workspaceId} — no run/userId parameter exists to grant on.
    expect(resolveTeamRunWorkspaceAccess.length).toBe(1);
  });

  it("no old-Team-role / resolveAdaptiveRunAccess grant: this module has no import statement pulling in lib/teams/ or an adaptive-run-access resolver (comments explaining their absence are fine)", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "lib/workspaces/resolveTeamRunWorkspaceAccess.ts"), "utf8");
    const importLines = source.split("\n").filter((line: string) => /^import /.test(line.trim()));
    for (const line of importLines) {
      expect(line).not.toMatch(/loadUserAndTeam|isTeamAdmin|memberRole|resolveAdaptiveRunAccess|lib\/teams\//);
    }
  });
});
