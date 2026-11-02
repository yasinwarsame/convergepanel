/**
 * "Projects assigned to me" (owner contract 2026-11-02), end to end below the HTTP seam:
 *
 *   GET /api/workspaces/{W}/projects?assignee=me
 *     → real route (identity → real resolveWorkspaceAccess + real role→capability map → D4 rule)
 *     → real listTeamProjects → real listActiveProjectsRaw + real listAssignedResearchProjectIds
 *     → in-memory Firestore that honours where / orderBy / startAfter / limit / select / getAll.
 *
 * Mocked seams only: token → uid (resolveRequestIdentity), the Workspace and membership documents behind
 * resolveWorkspaceAccess, and the presentation-only assignee enrichment.
 *
 * Contract: the list = Projects directly assigned to the caller ∪ Projects containing research assigned to the caller,
 * in the requested status, once each, for a caller who can read the Workspace's Projects. A run assignment counts only
 * while the caller is an eligible research assignee (D4). Nothing here grants access: every listed Project is one the
 * caller could already read in the unfiltered list.
 */

const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/env", () => ({ TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...a: unknown[]) => mockedGetWorkspace(...a) }));
const mockedGetMembership = jest.fn();
jest.mock("@/lib/firestore/workspaceMemberships", () => ({ getWorkspaceMembershipForBinding: (...a: unknown[]) => mockedGetMembership(...a) }));
jest.mock("@/lib/workspaces/teamProjectAssigneeEnrichment", () => ({
  enrichTeamProjectDtos: async (_w: string, items: { project: { id: string; name: string } }[]) => items.map((i) => ({ id: i.project.id, name: i.project.name })),
}));
jest.mock("@/lib/firestore/teamProjects", () => ({ createTeamProject: jest.fn() }));
jest.mock("@/lib/projects/writeTeamProjectEventSafely", () => ({ writeTeamProjectEventSafely: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// ---- in-memory Firestore -------------------------------------------------------------------------------------------
type Doc = { id: string; data: Record<string, unknown> };
const store: Record<string, Doc[]> = { projects: [], runs: [] };
const queryLog: { collection: string; filters: string[] }[] = [];
const DOC_ID = "__name__";

function cmpValues(a: unknown, b: unknown): number {
  if (a && typeof a === "object" && "seconds" in (a as object)) {
    const x = a as { seconds: number; nanoseconds: number };
    const y = b as { seconds: number; nanoseconds: number };
    return x.seconds - y.seconds || x.nanoseconds - y.nanoseconds;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

class FakeQuery {
  constructor(
    private name: string,
    private filters: { field: string; op: string; value: unknown }[] = [],
    private orders: { field: string; dir: string }[] = [],
    private after: unknown[] | null = null,
    private max = Infinity,
    private fields: string[] | null = null
  ) {}
  private clone(p: Partial<{ filters: FakeQuery["filters"]; orders: FakeQuery["orders"]; after: unknown[] | null; max: number; fields: string[] | null }>) {
    return new FakeQuery(this.name, p.filters ?? this.filters, p.orders ?? this.orders, p.after !== undefined ? p.after : this.after, p.max ?? this.max, p.fields !== undefined ? p.fields : this.fields);
  }
  doc(id: string) {
    return { __collection: this.name, __id: id };
  }
  where(field: string, op: string, value: unknown) {
    return this.clone({ filters: [...this.filters, { field, op, value }] });
  }
  orderBy(field: unknown, dir = "asc") {
    return this.clone({ orders: [...this.orders, { field: typeof field === "string" ? field : DOC_ID, dir }] });
  }
  startAfter(...vals: unknown[]) {
    // A document snapshot cursor resolves to its ordering values.
    if (vals.length === 1 && vals[0] && typeof vals[0] === "object" && "__snap" in (vals[0] as object)) {
      const d = (vals[0] as { __snap: Doc }).__snap;
      return this.clone({ after: this.orders.map((o) => (o.field === DOC_ID ? d.id : d.data[o.field])) });
    }
    return this.clone({ after: vals });
  }
  limit(n: number) {
    return this.clone({ max: n });
  }
  select(...fields: string[]) {
    return this.clone({ fields });
  }
  async get() {
    queryLog.push({ collection: this.name, filters: this.filters.map((f) => `${f.field} ${f.op} ${String(f.value)}`) });
    const key = (d: Doc) => this.orders.map((o) => (o.field === DOC_ID ? d.id : d.data[o.field]));
    const cmp = (a: unknown[], b: unknown[]) => {
      for (let i = 0; i < this.orders.length; i++) {
        const c = cmpValues(a[i], b[i]) * (this.orders[i].dir === "desc" ? -1 : 1);
        if (c !== 0) return c;
      }
      return 0;
    };
    let docs = store[this.name].filter((d) =>
      this.filters.every((f) => (f.op === "array-contains" ? Array.isArray(d.data[f.field]) && (d.data[f.field] as unknown[]).includes(f.value) : d.data[f.field] === f.value))
    );
    docs = [...docs].sort((a, b) => cmp(key(a), key(b)));
    if (this.after) docs = docs.filter((d) => cmp(key(d), this.after!) > 0);
    docs = docs.slice(0, this.max);
    const fields = this.fields;
    return {
      docs: docs.map((d) => {
        const data = fields ? Object.fromEntries(fields.filter((f) => f in d.data).map((f) => [f, d.data[f]])) : d.data;
        return { __snap: d, id: d.id, data: () => data, get: (f: string) => data[f], updateTime: new Timestamp(1, 0) };
      }),
    };
  }
}
const fakeDb = {
  collection: (name: string) => new FakeQuery(name),
  getAll: async (...refs: { __collection: string; __id: string }[]) =>
    refs.map((r) => {
      const d = store[r.__collection].find((x) => x.id === r.__id);
      return { id: r.__id, exists: d !== undefined, data: () => d?.data, updateTime: new Timestamp(1, 0) };
    }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fakeDb;
  },
}));

import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/projects/route";
import type { WorkspaceMembershipRole } from "@/lib/workspaces/membershipTypes";

const W = "ws-team-1";
const OTHER_W = "ws-team-2";
const ME = "uid-me";
const ALICE = "uid-alice";
const ME_EMAIL = "me@example.com";

const T = (s: number) => new Timestamp(s, 0);
function project(id: string, created: number, extra: Record<string, unknown> = {}): Doc {
  return { id, data: { schemaVersion: 1, id, workspaceId: W, name: `Project ${id}`, status: "active", createdByUserId: ALICE, createdAt: T(created), updatedAt: T(created), ...extra } };
}
let runSeq = 0;
function run(projectId: string | null, assigneeUid: string | null, extra: Record<string, unknown> = {}): Doc {
  runSeq += 1;
  return { id: `run-${runSeq}`, data: { workspaceId: W, projectId, assigneeUid, userId: ALICE, createdAt: T(1000 + runSeq), ...extra } };
}

/** uid → membership role in W (absent = not a member; "removed" = a removed membership). */
let members: Record<string, WorkspaceMembershipRole | "removed"> = {};

beforeEach(() => {
  jest.clearAllMocks();
  store.projects = [];
  store.runs = [];
  queryLog.length = 0;
  runSeq = 0;
  members = { [ME]: "member", [ALICE]: "admin" };
  mockedGetWorkspace.mockImplementation(async (id: string) => ({ status: "found", workspace: { schemaVersion: 1, id, type: "team", name: "Team", ownerUserId: Object.keys(members).find((u) => members[u] === "owner") ?? ALICE, createdByUserId: ALICE, createdAt: T(1), updatedAt: T(1) } }));
  mockedGetMembership.mockImplementation(async ({ workspaceId, uid }: { workspaceId: string; uid: string }) => {
    const role = workspaceId === W ? members[uid] : undefined;
    if (!role) return { status: "not_found" };
    return {
      status: "found",
      membership: { schemaVersion: 1, id: "wm_x", workspaceId, uid, role: role === "removed" ? "member" : role, status: role === "removed" ? "removed" : "active", createdAt: T(1), updatedAt: T(1), invitedByUserId: null, removedAt: null, removedByUserId: null },
    };
  });
});

async function listAs(uid: string, query = "assignee=me", workspaceId = W) {
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/projects?${query}`, { method: "GET" }), { params: { workspaceId } });
  const body = await res.json();
  return { status: res.status, body, ids: Array.isArray(body.items) ? body.items.map((i: { id: string }) => i.id) : null };
}

describe("the reported failure, reproduced", () => {
  it("a Project whose only link to me is research assigned to me is listed under 'Assigned to me'", async () => {
    store.projects = [project("p-research", 10)];
    store.runs = [run("p-research", ME)];
    expect((await listAs(ME)).ids).toEqual(["p-research"]);
  });
});

describe("1–4: the union, exactly", () => {
  beforeEach(() => {
    store.projects = [
      project("p-direct", 50, { assigneeUids: [ME] }),
      project("p-research", 40),
      project("p-both", 30, { assigneeUids: [ALICE, ME] }),
      project("p-unassigned", 20),
      project("p-alice", 10, { assigneeUids: [ALICE] }),
    ];
    store.runs = [run("p-research", ME), run("p-both", ME), run("p-both", ME), run("p-alice", ALICE), run("p-unassigned", null), run(null, ME)];
  });

  it("directly assigned, containing assigned research and both are each listed once, newest first; nothing else", async () => {
    const r = await listAs(ME);
    expect(r.status).toBe(200);
    expect(r.ids).toEqual(["p-direct", "p-research", "p-both"]);
    expect(r.body.hasMore).toBe(false);
  });

  it("without the filter the list is unchanged: every Project, and no research query is made", async () => {
    const r = await listAs(ME, "");
    expect(r.ids).toEqual(["p-direct", "p-research", "p-both", "p-unassigned", "p-alice"]);
    expect(queryLog.filter((q) => q.collection === "runs")).toHaveLength(0);
  });

  it("another member sees only their own assignments", async () => {
    expect((await listAs(ALICE)).ids).toEqual(["p-both", "p-alice"]);
  });

  it("the research query is scoped to this Workspace and to my own uid", async () => {
    await listAs(ME);
    const runsQueries = queryLog.filter((q) => q.collection === "runs");
    expect(runsQueries.length).toBeGreaterThan(0);
    for (const q of runsQueries) expect(q.filters).toEqual([`workspaceId == ${W}`, `assigneeUid == ${ME}`]);
  });

  it("pages through the union with the list's own cursor: no duplicate, no gap", async () => {
    const seen: string[] = [];
    let q = "assignee=me&limit=1";
    for (let i = 0; i < 5; i++) {
      const r = await listAs(ME, q);
      expect(r.status).toBe(200);
      seen.push(...r.ids);
      if (!r.body.hasMore) break;
      q = `assignee=me&limit=1&cursor=${encodeURIComponent(r.body.nextCursor)}`;
    }
    expect(seen).toEqual(["p-direct", "p-research", "p-both"]);
  });
});

describe("5–6: no unauthorized visibility", () => {
  it("research assigned to me in ANOTHER Workspace never lists that Workspace's Project here", async () => {
    store.projects = [project("p-here", 10), { ...project("p-there", 20), data: { ...project("p-there", 20).data, workspaceId: OTHER_W } }];
    store.runs = [run("p-there", ME, { workspaceId: OTHER_W })];
    expect((await listAs(ME)).ids).toEqual([]);
  });

  it("a non-member is refused (404) and no Project or research query runs", async () => {
    store.projects = [project("p-research", 10)];
    store.runs = [run("p-research", "uid-outsider")];
    const r = await listAs("uid-outsider");
    expect(r.status).toBe(404);
    expect(r.ids).toBeNull();
    expect(queryLog).toHaveLength(0);
  });

  it("a removed member is refused (404) even though research is still assigned to them", async () => {
    members[ME] = "removed";
    store.projects = [project("p-research", 10)];
    store.runs = [run("p-research", ME)];
    expect((await listAs(ME)).status).toBe(404);
    expect(queryLog).toHaveLength(0);
  });

  it("the same email text under a different authenticated identity matches nothing", async () => {
    const IMPOSTER = "uid-imposter";
    members[IMPOSTER] = "member";
    store.projects = [project("p-direct", 20, { assigneeUids: [ME] }), project("p-research", 10)];
    // Assignments are stored by uid; an email string stored by mistake is never treated as an identity either.
    store.runs = [run("p-research", ME), run("p-research", ME_EMAIL)];
    expect((await listAs(IMPOSTER)).ids).toEqual([]);
    expect((await listAs(ME)).ids).toEqual(["p-direct", "p-research"]);
  });

  it("the caller cannot name someone else: any assignee value other than 'me' is rejected (400) before any query", async () => {
    for (const q of [`assignee=${ALICE}`, `assignee=${ME}`, "assignee=me&assignee=me"]) {
      expect((await listAs(ME, q)).status).toBe(400);
    }
    expect(queryLog).toHaveLength(0);
  });
});

describe("7: removing an assignment updates the view on the next read", () => {
  it("research unassigned, moved out of the Project, or the Project unassigned: each removes the Project", async () => {
    store.projects = [project("p-direct", 20, { assigneeUids: [ME] }), project("p-research", 10)];
    const r1 = run("p-research", ME);
    store.runs = [r1];
    expect((await listAs(ME)).ids).toEqual(["p-direct", "p-research"]);
    r1.data.assigneeUid = null;
    expect((await listAs(ME)).ids).toEqual(["p-direct"]);
    r1.data.assigneeUid = ME;
    r1.data.projectId = null; // moved to unfiled
    expect((await listAs(ME)).ids).toEqual(["p-direct"]);
    store.projects[0].data.assigneeUids = [];
    expect((await listAs(ME)).ids).toEqual([]);
  });

  it("reassigning research to someone else removes it from my view and adds it to theirs", async () => {
    store.projects = [project("p-research", 10)];
    const r1 = run("p-research", ME);
    store.runs = [r1];
    r1.data.assigneeUid = ALICE;
    expect((await listAs(ME)).ids).toEqual([]);
    expect((await listAs(ALICE)).ids).toEqual(["p-research"]);
  });
});

describe("8: existing membership rules are intact (D4)", () => {
  beforeEach(() => {
    store.projects = [project("p-direct", 20, { assigneeUids: [ME] }), project("p-research", 10)];
    store.runs = [run("p-research", ME)];
  });

  it.each(["owner", "admin", "member"] as const)("%s: both links count", async (role) => {
    members[ME] = role;
    expect((await listAs(ME)).ids).toEqual(["p-direct", "p-research"]);
  });

  it.each(["viewer", "reviewer"] as const)("%s (cannot currently be a research assignee): a stale research assignment adds nothing; direct still counts", async (role) => {
    members[ME] = role;
    expect((await listAs(ME)).ids).toEqual(["p-direct"]);
    expect(queryLog.filter((q) => q.collection === "runs")).toHaveLength(0);
  });

  it("an archived Project appears in the archived list, not the active one", async () => {
    store.projects[1].data.status = "archived";
    expect((await listAs(ME)).ids).toEqual(["p-direct"]);
    expect((await listAs(ME, "assignee=me&status=archived")).ids).toEqual(["p-research"]);
  });
});

describe("9: refresh and a new session give the same answer", () => {
  it("two independent reads, each resolving identity afresh, return the same list", async () => {
    store.projects = [project("p-direct", 20, { assigneeUids: [ME] }), project("p-research", 10)];
    store.runs = [run("p-research", ME)];
    const first = await listAs(ME);
    const second = await listAs(ME);
    expect(second.ids).toEqual(first.ids);
    expect(mockedIdentity).toHaveBeenCalledTimes(2);
    expect(mockedGetMembership).toHaveBeenCalledTimes(2);
  });
});

describe("integrity: fails closed like the rest of the list", () => {
  it("research pointing at a missing Project fails the page (500), never a partial list", async () => {
    store.projects = [project("p-direct", 20, { assigneeUids: [ME] })];
    store.runs = [run("p-gone", ME)];
    expect((await listAs(ME)).status).toBe(500);
  });

  it("research pointing at another Workspace's Project fails the page (500)", async () => {
    store.projects = [{ ...project("p-foreign", 20), data: { ...project("p-foreign", 20).data, workspaceId: OTHER_W } }];
    store.runs = [run("p-foreign", ME)];
    expect((await listAs(ME)).status).toBe(500);
  });

  it("a malformed projectId on an assigned run fails the page (500)", async () => {
    store.runs = [run(42 as unknown as string, ME)];
    expect((await listAs(ME)).status).toBe(500);
  });
});

describe("bounds: large inputs are read in full or fail closed, never truncated silently", () => {
  it("4,999 assigned runs across pages are all read (the scan pages past 500)", async () => {
    store.projects = [project("p-first", 20), project("p-last", 10)];
    // The oldest run (read on the last page) is the only link to p-last.
    store.runs = [run("p-last", ME), ...Array.from({ length: 4998 }, () => run("p-first", ME))];
    const r = await listAs(ME);
    expect(r.status).toBe(200);
    expect(r.ids).toEqual(["p-first", "p-last"]);
  });

  it("more assigned runs than the scan bound fails the page (500) rather than listing a partial set", async () => {
    store.projects = [project("p-first", 20)];
    store.runs = Array.from({ length: 5001 }, () => run("p-first", ME));
    expect((await listAs(ME)).status).toBe(500);
  });

  it("more directly assigned Projects than the bound fails the page (500)", async () => {
    store.projects = Array.from({ length: 501 }, (_, i) => project(`p-${String(i).padStart(3, "0")}`, 10 + i, { assigneeUids: [ME] }));
    expect((await listAs(ME)).status).toBe(500);
  });
});
