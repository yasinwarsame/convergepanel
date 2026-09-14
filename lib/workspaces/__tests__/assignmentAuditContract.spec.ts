/**
 * PR #164 review C6 — CROSS-READER CONTRACT tests. Every event below is
 * produced by the REAL mutation primitives against one in-memory Firestore
 * fake (buffered transactions + native precondition), then read back by
 * the REAL audit reader from the same store, parsed by the REAL client
 * parser, and rendered by the REAL Audit Log card. No reader fixture is
 * invented by hand. Covers:
 *   1. run writer's `projectId: string / projectName: null` (filed run,
 *      Project missing) → reader → parser → card (C2);
 *   2. malformed Project list repair (`"x"` → `[]`, empty diff) (C3);
 *   3. malformed run assignee repair (`42` → `null`, null === null) (C3);
 *   4. over-cap (1,000 uid) persisted Project list through the REAL
 *      Project list reader + enrichment path, and its bounded repair (C4);
 *   5. a committed Project assignment whose presentation enrichment then
 *      fails still yields a DTO (C1).
 * Positive controls: well-formed same-state requests write NO event (D6).
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
const stores: Record<string, Map<string, StoredDoc>> = { workspaces: new Map(), workspaceMemberships: new Map(), projects: new Map(), runs: new Map(), workspaceMembershipEvents: new Map() };
let counter = 0;
const nextUpdateTime = () => new Timestamp(1_700_000_000 + ++counter, 0);
const getAllSpy = jest.fn();

function makeDocRef(collection: string, id: string) {
  return {
    __collection: collection,
    __id: id,
    id,
    get: async () => {
      const e = stores[collection].get(id);
      return { exists: e !== undefined, data: () => e?.data, updateTime: e?.updateTime, id };
    },
  };
}
class FakeQuery {
  constructor(
    private collection: string,
    private filters: Array<{ field: string; op: string; value: unknown }> = []
  ) {}
  doc(id?: string) {
    return makeDocRef(this.collection, id ?? `auto-${++counter}`);
  }
  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.collection, [...this.filters, { field, op, value }]);
  }
  orderBy() {
    return this;
  }
  startAfter() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    const docs = Array.from(stores[this.collection].entries())
      .filter(([, e]) => this.filters.every((f) => (f.op === "array-contains" ? Array.isArray(e.data[f.field]) && (e.data[f.field] as unknown[]).includes(f.value) : e.data[f.field] === f.value)))
      .map(([id, e]) => ({ id, data: () => e.data, updateTime: e.updateTime }));
    return { docs };
  }
}
const mockAdminDb: any = {
  collection: (name: string) => new FakeQuery(name),
  getAll: (...refs: { __collection: string; __id: string }[]) => {
    getAllSpy(refs.length);
    return Promise.resolve(refs.map((r) => ({ id: r.__id, exists: stores[r.__collection]?.has(r.__id) ?? false, data: () => stores[r.__collection]?.get(r.__id)?.data })));
  },
  runTransaction: async (fn: (t: any) => Promise<any>) => {
    const pending: Array<() => void> = [];
    let hasWritten = false;
    const tx = {
      get: async (ref: { __collection: string; __id: string }) => {
        if (hasWritten) throw new Error("reads before writes");
        const e = stores[ref.__collection].get(ref.__id);
        return { exists: e !== undefined, data: () => e?.data, updateTime: e?.updateTime, id: ref.__id };
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>, precondition?: { lastUpdateTime?: Timestamp }) => {
        hasWritten = true;
        const e = stores[ref.__collection].get(ref.__id)!;
        if (precondition?.lastUpdateTime && (e.updateTime.seconds !== precondition.lastUpdateTime.seconds || e.updateTime.nanoseconds !== precondition.lastUpdateTime.nanoseconds)) throw new Error("FAILED_PRECONDITION");
        pending.push(() => stores[ref.__collection].set(ref.__id, { data: { ...e.data, ...data }, updateTime: nextUpdateTime() }));
      },
      set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        hasWritten = true;
        pending.push(() => stores[ref.__collection].set(ref.__id, { data, updateTime: nextUpdateTime() }));
      },
    };
    const r = await fn(tx);
    pending.forEach((w) => w());
    return r;
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));
jest.mock("@/lib/env", () => ({ TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, PROJECT_ASSIGNMENT_ENABLED: true, PROJECT_ASSIGNMENT_CANARY_UIDS: undefined }));
const mockedLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));
const mockNames = jest.fn();
jest.mock("../workspaceReviewerIdentity", () => ({
  REVIEWER_UNAVAILABLE_LABEL: "Unavailable reviewer",
  resolveWorkspaceReviewerDisplayNames: (...a: unknown[]) => mockNames(...a),
}));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
// The client module is REAL for parsing; the Audit Log shell's own fetch is
// switched to the already-parsed result so the card renders exactly what
// the real parser accepted (one module instance — never a second React).
let shellFeed: unknown = null;
jest.mock("@/lib/client/workspaceTeamClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceTeamClient");
  return { ...actual, fetchWorkspaceAuditEvents: (...a: unknown[]) => (shellFeed !== null ? Promise.resolve(shellFeed) : actual.fetchWorkspaceAuditEvents(...a)) };
});
const stableAuth = { user: { uid: "u" }, loading: false, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => stableAuth }));
jest.mock("next/link", () => {
  const MockLink = ({ href, children }: { href: string; children: React.ReactNode }) => require("react").createElement("a", { href }, children);
  return { __esModule: true, default: MockLink };
});

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { computeMembershipId } from "../membershipId";
import { setTeamRunAssignee } from "@/lib/projects/setTeamRunAssignee";
import { updateTeamProjectFields } from "@/lib/firestore/teamProjects";
import { listWorkspaceAuditEvents } from "../listWorkspaceAuditEvents";
import { listTeamProjects } from "@/lib/projects/listTeamProjects";
import { enrichTeamProjectDtos } from "../teamProjectAssigneeEnrichment";
import { fetchWorkspaceAuditEvents, type WorkspaceAuditEventItem } from "@/lib/client/workspaceTeamClient";
import Shell from "@/components/workspace/WorkspaceAuditLogShell";

const WS_ID = "ws-team-1";
const OWNER = "owner-1";
const MEMBER = "member-1";
const PROJECT_ID = "proj-1";
const RUN_ID = "run-1";
const NOW = Timestamp.now();
const BIG = Array.from({ length: 1000 }, (_, i) => `persisted-user-${String(i).padStart(4, "0")}`);

function seedMembership(uid: string, role: string) {
  const id = computeMembershipId(WS_ID, uid);
  stores.workspaceMemberships.set(id, { data: { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null }, updateTime: nextUpdateTime() });
}
function seedProject(overrides: Record<string, unknown> = {}) {
  const updateTime = nextUpdateTime();
  stores.projects.set(PROJECT_ID, { data: { schemaVersion: 1, id: PROJECT_ID, workspaceId: WS_ID, name: "Due Diligence", status: "active", createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW, ...overrides }, updateTime });
  return updateTime;
}
function seedRun(overrides: Record<string, unknown> = {}) {
  stores.runs.set(RUN_ID, { data: { userId: OWNER, workspaceId: WS_ID, projectId: PROJECT_ID, question: "What is the TAM?", status: "complete", createdAt: NOW, ...overrides }, updateTime: nextUpdateTime() });
}
const events = () => Array.from(stores.workspaceMembershipEvents.values()).map((e) => e.data);
async function readThroughEverything(): Promise<{ dto: unknown; parsed: WorkspaceAuditEventItem; rendered: string }> {
  const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
  if (r.status !== "ok") throw new Error("reader failed");
  expect(r.items).toHaveLength(1);
  const dto = r.items[0];
  mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, events: [dto], hasMore: false }) });
  shellFeed = null;
  const parsed = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: WS_ID });
  if (parsed.status !== "ok") throw new Error("client parser rejected the reader's DTO");
  shellFeed = parsed;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Shell, { workspaceId: WS_ID, workspaceName: "Acme" } as never));
  });
  return { dto, parsed: parsed.events[0], rendered: JSON.stringify(renderer.toJSON()) };
}

beforeEach(() => {
  for (const s of Object.values(stores)) s.clear();
  getAllSpy.mockClear();
  mockedLogger.warn.mockClear();
  mockNames.mockReset();
  mockNames.mockImplementation(async (_ws: string, uids: string[], fallback: string) => new Map(uids.map((u) => [u, u === OWNER ? "Amina" : u === MEMBER ? "Bao" : fallback])));
  stores.workspaces.set(WS_ID, { data: { schemaVersion: 1, id: WS_ID, type: "team", name: "Acme", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW }, updateTime: nextUpdateTime() });
  seedMembership(OWNER, "owner");
  seedMembership(MEMBER, "member");
  shellFeed = null;
});

it("1 (C2) — run writer's string/null Project snapshot (filed run, Project missing) survives reader → parser → card as 'Project unavailable', never 'Unfiled', never the id", async () => {
  seedRun(); // references PROJECT_ID, which is NOT seeded
  const w = await setTeamRunAssignee({ uid: OWNER, workspaceId: WS_ID, runId: RUN_ID, assigneeUid: MEMBER, expectedAssigneeUid: null });
  expect(w.status).toBe("assigned");
  expect(events()[0]).toMatchObject({ projectId: PROJECT_ID, projectName: null });
  const { dto, parsed, rendered } = await readThroughEverything();
  expect(dto).toMatchObject({ eventType: "workspace_research_assignee_changed", project: { unavailable: true }, assignee: { displayName: "Bao" }, previousAssignee: null, repair: false });
  expect(JSON.stringify(dto)).not.toContain(PROJECT_ID);
  expect(parsed.eventType).toBe("workspace_research_assignee_changed");
  expect(rendered).toContain("Research assignee changed");
  expect(rendered).toContain("in a Project that is no longer available");
  expect(rendered).not.toContain("Unfiled");
  expect(rendered).not.toContain(PROJECT_ID);
});

it("2 (C3) — malformed Project list repair ('x' → []) is a real write whose EMPTY-diff event survives to a truthful 'repaired' card; positive control: a well-formed same-state request writes NO event", async () => {
  let token = seedProject({ assigneeUids: "x" });
  const w = await updateTeamProjectFields({ uid: OWNER, workspaceId: WS_ID, projectId: PROJECT_ID, mutation: { kind: "set_assignees", assigneeUids: [] }, expectedUpdateTime: token });
  expect(w.status).toBe("updated");
  expect(stores.projects.get(PROJECT_ID)!.data.assigneeUids).toEqual([]);
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({ eventType: "workspace_project_assignees_changed", addedUids: [], removedUids: [] });
  const { dto, rendered } = await readThroughEverything();
  expect(dto).toMatchObject({ eventType: "workspace_project_assignees_changed", repair: true, added: [], removed: [] });
  expect(rendered).toContain("Project assignment repaired");
  expect(rendered).toContain("No one was added or removed.");
  expect(rendered).not.toContain("Added: ");
  // POSITIVE CONTROL (D6): the now-canonical [] requested again ⇒ unchanged, no new event.
  token = stores.projects.get(PROJECT_ID)!.updateTime;
  const noop = await updateTeamProjectFields({ uid: OWNER, workspaceId: WS_ID, projectId: PROJECT_ID, mutation: { kind: "set_assignees", assigneeUids: [] }, expectedUpdateTime: token });
  expect(noop.status).toBe("unchanged");
  expect(events()).toHaveLength(1);
});

it("3 (C3) — malformed run assignee repair (42 → null) is a real write whose null === null event survives to a 'repaired' card; positive control: a well-formed null → null request writes NO event", async () => {
  seedProject();
  seedRun({ assigneeUid: 42 });
  const w = await setTeamRunAssignee({ uid: OWNER, workspaceId: WS_ID, runId: RUN_ID, assigneeUid: null, expectedAssigneeUid: null });
  expect(w.status).toBe("assigned");
  expect(stores.runs.get(RUN_ID)!.data.assigneeUid).toBeNull();
  expect(events()[0]).toMatchObject({ eventType: "workspace_research_assignee_changed", previousAssigneeUid: null, assigneeUid: null, projectName: "Due Diligence" });
  const { dto, rendered } = await readThroughEverything();
  expect(dto).toMatchObject({ repair: true, previousAssignee: null, assignee: null, project: { name: "Due Diligence" } });
  expect(rendered).toContain("Research assignment repaired");
  expect(rendered).toContain("assignment metadata was repaired");
  expect(rendered).not.toContain("Previously: ");
  const noop = await setTeamRunAssignee({ uid: OWNER, workspaceId: WS_ID, runId: RUN_ID, assigneeUid: null, expectedAssigneeUid: null });
  expect(noop.status).toBe("unchanged");
  expect(events()).toHaveLength(1);
});

it("4 (C4) — a 1,000-uid persisted Project list through the REAL list reader + enrichment: no membership/name batch, DTO assignees [], anomaly logged without the list; repair writes a BOUNDED event", async () => {
  const token = seedProject({ assigneeUids: BIG });
  const listed = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
  expect(listed.status).toBe("ok");
  if (listed.status !== "ok") throw new Error("unreachable");
  const dtos = await enrichTeamProjectDtos(WS_ID, listed.items);
  expect(dtos[0].assignees).toEqual([]);
  expect(getAllSpy).not.toHaveBeenCalled();
  expect(mockNames).not.toHaveBeenCalled();
  const logged = JSON.stringify(mockedLogger.warn.mock.calls);
  expect(logged).not.toContain("persisted-user-0500");
  expect(JSON.stringify(dtos)).not.toContain("persisted-user");
  // Repair remains possible and the audit payload is bounded.
  const w = await updateTeamProjectFields({ uid: OWNER, workspaceId: WS_ID, projectId: PROJECT_ID, mutation: { kind: "set_assignees", assigneeUids: [MEMBER] }, expectedUpdateTime: token });
  expect(w.status).toBe("updated");
  expect(stores.projects.get(PROJECT_ID)!.data.assigneeUids).toEqual([MEMBER]);
  expect(events()[0]).toMatchObject({ addedUids: [MEMBER], removedUids: [] });
  expect(JSON.stringify(events()[0]).length).toBeLessThan(500);
  const { dto } = await readThroughEverything();
  expect(dto).toMatchObject({ repair: false, added: [{ displayName: "Bao" }], removed: [] });
});

it("5 (C1) — a committed Project assignment whose presentation then FAILS still yields a DTO with degraded assignees (never a rejection)", async () => {
  const token = seedProject();
  const w = await updateTeamProjectFields({ uid: OWNER, workspaceId: WS_ID, projectId: PROJECT_ID, mutation: { kind: "set_assignees", assigneeUids: [MEMBER] }, expectedUpdateTime: token });
  expect(w.status).toBe("updated");
  if (w.status !== "updated") throw new Error("unreachable");
  mockNames.mockRejectedValue(new Error("UNAVAILABLE"));
  const dtos = await enrichTeamProjectDtos(WS_ID, [{ project: w.project, documentUpdateTime: w.documentUpdateTime }]);
  expect(dtos[0].assignees).toEqual([{ uid: MEMBER, displayName: "Unavailable reviewer", state: "active" }]);
});
