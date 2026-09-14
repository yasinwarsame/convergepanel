/**
 * Project/Research Assignment — the THIRD seat-independence spec (brief
 * §6.11): the assignment mutations are orthogonal to the collaborator-seat
 * entitlement. The fake Firestore below deliberately registers NO
 * `teamWorkspaceSeatAdmission` store — any `tx.get()` against it throws
 * (structural tripwire) — and a Workspace already OVER the seat limit
 * still takes assignments. The POSITIVE CONTROL runs the real seat
 * primitive the invitation path calls (`reserveTeamWorkspaceSeat`) against
 * the SAME fake and shows it trips, proving the tripwire is live.
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
// Deliberately NO `teamWorkspaceSeatAdmission` entry.
const stores: Record<string, Map<string, StoredDoc>> = { workspaces: new Map(), workspaceMemberships: new Map(), projects: new Map(), runs: new Map(), workspaceMembershipEvents: new Map() };
let counter = 0;
const nextUpdateTime = () => new Timestamp(1_700_000_000 + ++counter, 0);
function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    id: docId,
    get: async () => {
      const entry = stores[collectionName].get(docId);
      return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
    },
  };
}
function makeTx() {
  const pending: Array<() => void> = [];
  const tx = {
    get: async (ref: { __collection: string; __id: string }) => {
      const store = stores[ref.__collection]; // undefined for any unregistered collection — throws below if ever touched
      const entry = store.get(ref.__id);
      return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime, id: ref.__id };
    },
    update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
      const entry = stores[ref.__collection].get(ref.__id)!;
      pending.push(() => stores[ref.__collection].set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() }));
    },
    set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
      pending.push(() => stores[ref.__collection].set(ref.__id, { data, updateTime: nextUpdateTime() }));
    },
    create: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
      pending.push(() => stores[ref.__collection].set(ref.__id, { data, updateTime: nextUpdateTime() }));
    },
  };
  return { tx, commit: () => pending.forEach((w) => w()) };
}
const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++counter}`) }),
  runTransaction: async (fn: (t: any) => Promise<any>) => {
    const { tx, commit } = makeTx();
    const r = await fn(tx);
    commit();
    return r;
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));
jest.mock("@/lib/env", () => ({ TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, PROJECT_ASSIGNMENT_ENABLED: true, PROJECT_ASSIGNMENT_CANARY_UIDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from "fs";
import { join } from "path";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { setTeamRunAssignee } from "@/lib/projects/setTeamRunAssignee";
import { updateTeamProjectFields } from "@/lib/firestore/teamProjects";
import { reserveTeamWorkspaceSeat } from "@/lib/workspaces/teamWorkspaceSeatAdmission";

const WS_ID = "ws-team-1";
const OWNER = "owner-1";
const NOW = Timestamp.now();
function seedMembership(uid: string, role: string) {
  const id = computeMembershipId(WS_ID, uid);
  stores.workspaceMemberships.set(id, { data: { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null }, updateTime: nextUpdateTime() });
}

beforeEach(() => {
  for (const s of Object.values(stores)) s.clear();
  stores.workspaces.set(WS_ID, { data: { schemaVersion: 1, id: WS_ID, type: "team", name: "Acme", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW }, updateTime: nextUpdateTime() });
  seedMembership(OWNER, "owner");
  // OVER the collaborator-seat limit: 7 non-owner members (the limit is 5).
  for (let i = 1; i <= 7; i++) seedMembership(`member-${i}`, "member");
  stores.projects.set("proj-1", { data: { schemaVersion: 1, id: "proj-1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW }, updateTime: nextUpdateTime() });
  stores.runs.set("run-1", { data: { userId: OWNER, workspaceId: WS_ID, projectId: "proj-1", question: "Q?", status: "complete", createdAt: NOW }, updateTime: nextUpdateTime() });
});

it("an over-seat-limit Workspace still takes a run assignment — the seat cache is never read (tripwire would throw)", async () => {
  const r = await setTeamRunAssignee({ uid: OWNER, workspaceId: WS_ID, runId: "run-1", assigneeUid: "member-7", expectedAssigneeUid: null });
  expect(r.status).toBe("assigned");
});

it("an over-seat-limit Workspace still takes a Project assignee list of 7 members", async () => {
  const token = stores.projects.get("proj-1")!.updateTime;
  const r = await updateTeamProjectFields({ uid: OWNER, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "set_assignees", assigneeUids: Array.from({ length: 7 }, (_, i) => `member-${i + 1}`) }, expectedUpdateTime: token });
  expect(r.status).toBe("updated");
});

it("POSITIVE CONTROL — the real seat primitive the invitation path calls DOES trip the same fake (so the two tests above are not vacuous)", async () => {
  const { tx } = makeTx();
  await expect(reserveTeamWorkspaceSeat(tx as never, WS_ID)).rejects.toThrow();
  expect(readFileSync(join(__dirname, "..", "..", "firestore", "workspaceInvitations.ts"), "utf8")).toMatch(/reserveTeamWorkspaceSeat|planTeamWorkspaceSeatReservation/);
});

it("structural ban — neither assignment primitive imports the seat/quota machinery", () => {
  for (const p of ["lib/projects/setTeamRunAssignee.ts", "lib/firestore/teamProjects.ts"]) {
    const src = readFileSync(join(__dirname, "..", "..", "..", p), "utf8");
    expect(src).not.toMatch(/teamWorkspaceSeatAdmission|teamWorkspaceSeatLimit|usageCheck|checkAndIncrementUsageForRun/);
  }
});
