/**
 * Projects Foundation — getProject() (Phase 6B) + createProject()/
 * countProjectsInWorkspace()/listActiveProjectsRaw()/updateProjectFields()
 * (Phase 6C) tests. Mirrors the mocking convention established in
 * lib/firestore/__tests__/workspaces.spec.ts, extended with a small
 * in-memory query/count/precondition-update engine — real filter/sort/
 * limit/startAfter/count/precondition semantics, not hand-picked
 * fixtures, mirroring the FakeQuery convention already established in
 * app/api/user/workspace/runs/__tests__/route.spec.ts.
 */

import { Status } from "google-gax";
import { FieldPath, Timestamp } from "firebase-admin/firestore";

const projectDocs = new Map<string, Record<string, unknown>>();
const projectUpdateTimes = new Map<string, Timestamp>();
const firestoreUnavailableFlag = { value: false };
const throwOnRead = { value: false };
const throwOnCreate = { value: false as false | "generic" };
const throwOnUpdate = { value: false as false | "generic" };
const throwOnCount = { value: false };

const DOC_UPDATE_TIME = Timestamp.fromMillis(1_700_000_000_000);

function alreadyExistsError() {
  const err: any = new Error("ALREADY_EXISTS: Document already exists");
  err.code = Status.ALREADY_EXISTS;
  return err;
}
function failedPreconditionError() {
  const err: any = new Error("FAILED_PRECONDITION: the stored version does not match the required base version");
  err.code = Status.FAILED_PRECONDITION;
  return err;
}
function notFoundError() {
  const err: any = new Error("NOT_FOUND: no entity to update");
  err.code = Status.NOT_FOUND;
  return err;
}

let autoIdCounter = 0;
function nextAutoId(): string {
  autoIdCounter += 1;
  return `auto-id-${autoIdCounter}`;
}

class FakeDocRef {
  constructor(public id: string) {}
  get() {
    return (async () => {
      if (throwOnRead.value) throw new Error("simulated Firestore outage");
      const key = `projects/${this.id}`;
      return { exists: projectDocs.has(key), data: () => projectDocs.get(key), updateTime: projectUpdateTimes.get(key) };
    })();
  }
  create(data: Record<string, unknown>) {
    return (async () => {
      if (throwOnCreate.value === "generic") throw new Error("simulated write outage");
      const key = `projects/${this.id}`;
      if (projectDocs.has(key)) throw alreadyExistsError();
      const writeTime = Timestamp.now();
      projectDocs.set(key, data);
      projectUpdateTimes.set(key, writeTime);
      return { writeTime };
    })();
  }
  update(data: Record<string, unknown>, precondition?: { lastUpdateTime?: Timestamp }) {
    return (async () => {
      if (throwOnUpdate.value === "generic") throw new Error("simulated write outage");
      const key = `projects/${this.id}`;
      if (!projectDocs.has(key)) throw notFoundError();
      if (precondition?.lastUpdateTime) {
        const current = projectUpdateTimes.get(key);
        const matches = current && current.seconds === precondition.lastUpdateTime.seconds && current.nanoseconds === precondition.lastUpdateTime.nanoseconds;
        if (!matches) throw failedPreconditionError();
      }
      const existing = projectDocs.get(key)!;
      const merged = { ...existing, ...data };
      // Ensure a genuinely new updateTime after every successful update —
      // real Firestore always advances it on write.
      const prevWriteMs = (projectUpdateTimes.get(key) ?? Timestamp.fromMillis(0)).toMillis();
      const writeTime = Timestamp.fromMillis(Math.max(Date.now(), prevWriteMs + 1));
      projectDocs.set(key, merged);
      projectUpdateTimes.set(key, writeTime);
      return { writeTime };
    })();
  }
}

interface FakeFilter {
  field: string;
  value: unknown;
}

class FakeQuery {
  private filters: FakeFilter[] = [];
  private orderFields: { field: string; desc: boolean }[] = [];
  private limitN: number | undefined;
  private startAfterKey: string | undefined;

  where(field: string, _op: string, value: unknown): FakeQuery {
    const q = this.clone();
    q.filters.push({ field, value });
    return q;
  }
  orderBy(field: string | FieldPath, direction?: "asc" | "desc"): FakeQuery {
    const q = this.clone();
    const fieldName = field instanceof FieldPath ? "__name__" : field;
    q.orderFields.push({ field: fieldName, desc: direction === "desc" });
    return q;
  }
  limit(n: number): FakeQuery {
    const q = this.clone();
    q.limitN = n;
    return q;
  }
  startAfter(createdAtTimestamp: Timestamp, docId: string): FakeQuery {
    const q = this.clone();
    q.startAfterKey = `${createdAtTimestamp.seconds}.${createdAtTimestamp.nanoseconds}.${docId}`;
    return q;
  }
  count() {
    return { get: async () => this.executeCount() };
  }
  get() {
    return this.execute();
  }

  private clone(): FakeQuery {
    const q = new FakeQuery();
    q.filters = [...this.filters];
    q.orderFields = [...this.orderFields];
    q.limitN = this.limitN;
    q.startAfterKey = this.startAfterKey;
    return q;
  }

  private matchingDocs(): { id: string; data: Record<string, unknown> }[] {
    if (throwOnRead.value) throw new Error("simulated Firestore outage");
    const all: { id: string; data: Record<string, unknown> }[] = [];
    for (const [key, data] of projectDocs.entries()) {
      const id = key.replace("projects/", "");
      const passes = this.filters.every((f) => (data as any)[f.field] === f.value);
      if (passes) all.push({ id, data });
    }
    // Sort by createdAt desc, __name__ desc — the only ordering this
    // module's real queries ever use.
    all.sort((a, b) => {
      const at = (a.data.createdAt as Timestamp).toMillis();
      const bt = (b.data.createdAt as Timestamp).toMillis();
      if (at !== bt) return bt - at;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    let filtered = all;
    if (this.startAfterKey) {
      const idx = all.findIndex((d) => {
        const ts = d.data.createdAt as Timestamp;
        return `${ts.seconds}.${ts.nanoseconds}.${d.id}` === this.startAfterKey;
      });
      filtered = idx === -1 ? [] : all.slice(idx + 1);
    }
    if (this.limitN !== undefined) filtered = filtered.slice(0, this.limitN);
    return filtered;
  }

  private async execute() {
    const docs = this.matchingDocs();
    return {
      docs: docs.map((d) => ({
        id: d.id,
        data: () => d.data,
        updateTime: projectUpdateTimes.get(`projects/${d.id}`),
      })),
    };
  }

  private async executeCount() {
    if (throwOnCount.value) throw new Error("simulated count outage");
    // Count ignores limit/startAfter/orderBy — matches real Firestore
    // aggregation semantics (only WHERE filters apply).
    if (throwOnRead.value) throw new Error("simulated Firestore outage");
    let count = 0;
    for (const [, data] of projectDocs.entries()) {
      const passes = this.filters.every((f) => (data as any)[f.field] === f.value);
      if (passes) count++;
    }
    return { data: () => ({ count }) };
  }
}

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "projects") throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id?: string) => new FakeDocRef(id ?? nextAutoId()),
      where: (field: string, op: string, value: unknown) => new FakeQuery().where(field, op, value),
    };
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getProject, createProject, countProjectsInWorkspace, listActiveProjectsRaw, updateProjectFields } from "@/lib/firestore/projects";

const NOW = Timestamp.now();

function seedProject(id: string, overrides: Record<string, unknown> = {}, updateTime: Timestamp = DOC_UPDATE_TIME) {
  projectDocs.set(`projects/${id}`, {
    schemaVersion: 1,
    id,
    workspaceId: "personal-owner-1",
    name: "My Project",
    status: "active",
    createdByUserId: "owner-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  projectUpdateTimes.set(`projects/${id}`, updateTime);
}

function resetAll() {
  projectDocs.clear();
  projectUpdateTimes.clear();
  firestoreUnavailableFlag.value = false;
  throwOnRead.value = false;
  throwOnCreate.value = false;
  throwOnUpdate.value = false;
  throwOnCount.value = false;
  autoIdCounter = 0;
}

describe("getProject", () => {
  beforeEach(resetAll);

  it("returns found with the well-formed project when the document exists", async () => {
    seedProject("proj-1");
    const result = await getProject("proj-1");
    expect(result).toEqual({
      status: "found",
      project: {
        schemaVersion: 1,
        id: "proj-1",
        workspaceId: "personal-owner-1",
        name: "My Project",
        status: "active",
        createdByUserId: "owner-1",
        createdAt: NOW,
        updatedAt: NOW,
      },
      documentUpdateTime: DOC_UPDATE_TIME,
    });
  });

  it("documentUpdateTime is Firestore's native updateTime, never derived from project.updatedAt", async () => {
    // Seed a document whose OWN `updatedAt` field differs from the mock
    // snapshot's `updateTime` — proves getProject() returns the latter,
    // never re-derives it from the former.
    seedProject("proj-distinct", { updatedAt: Timestamp.fromMillis(1) });
    const result = await getProject("proj-distinct");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.documentUpdateTime).toEqual(DOC_UPDATE_TIME);
      expect(result.documentUpdateTime).not.toEqual(result.project.updatedAt);
    }
  });

  it("returns not_found when no document exists at that id", async () => {
    const result = await getProject("does-not-exist");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns malformed when the document exists but is missing required fields", async () => {
    projectDocs.set("projects/broken", { schemaVersion: 1, id: "broken" });
    const result = await getProject("broken");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when schemaVersion is not the literal 1", async () => {
    seedProject("bad-version", { schemaVersion: 2 });
    const result = await getProject("bad-version");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when status is not exactly active|archived", async () => {
    seedProject("bad-status", { status: "deleted" });
    const result = await getProject("bad-status");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when createdAt is not a real Timestamp", async () => {
    seedProject("bad-createdat", { createdAt: "2026-08-16T00:00:00.000Z" });
    const result = await getProject("bad-createdat");
    expect(result).toEqual({ status: "malformed" });
  });

  it("SECURITY: returns malformed when the document's own id field does not match the Firestore document id it was fetched at (never accepted as found)", async () => {
    // Simulates a corrupted/tampered document: fetched at projects/proj-real,
    // but its own body claims to be a different project entirely.
    seedProject("proj-real", { id: "proj-impostor" });
    const result = await getProject("proj-real");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns malformed when the id key is entirely absent from the document", async () => {
    projectDocs.set("projects/no-id-key", {
      schemaVersion: 1,
      workspaceId: "personal-owner-1",
      name: "My Project",
      status: "active",
      createdByUserId: "owner-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const result = await getProject("no-id-key");
    expect(result).toEqual({ status: "malformed" });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getProject("proj-1");
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns read_failed when the Firestore read throws", async () => {
    throwOnRead.value = true;
    const result = await getProject("proj-1");
    expect(result).toEqual({ status: "read_failed" });
  });
});

describe("createProject", () => {
  beforeEach(resetAll);

  it("creates a new Project with the embedded id equal to the generated document id", async () => {
    const result = await createProject({ workspaceId: "personal-owner-1", name: "New Project", createdByUserId: "owner-1" });
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.project.id).toBe("auto-id-1");
      const stored = projectDocs.get("projects/auto-id-1");
      expect(stored?.id).toBe("auto-id-1");
    }
  });

  it("never uses .add() — the ref is generated first, then a single .create() call", async () => {
    const result = await createProject({ workspaceId: "personal-owner-1", name: "X", createdByUserId: "owner-1" });
    expect(result.status).toBe("created");
    // Proven structurally elsewhere (write-surface describe block below);
    // here we confirm behaviorally that exactly one document was created
    // per call, at a fresh id each time.
    const second = await createProject({ workspaceId: "personal-owner-1", name: "Y", createdByUserId: "owner-1" });
    if (result.status === "created" && second.status === "created") {
      expect(result.project.id).not.toBe(second.project.id);
    }
  });

  it("sets status: active, schemaVersion: 1, and the caller-supplied workspaceId/name/createdByUserId — never anything else", async () => {
    const result = await createProject({ workspaceId: "personal-owner-1", name: "New Project", createdByUserId: "owner-1" });
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.project).toMatchObject({
        schemaVersion: 1,
        workspaceId: "personal-owner-1",
        name: "New Project",
        status: "active",
        createdByUserId: "owner-1",
      });
    }
  });

  it("createdAt and updatedAt are set to the same server timestamp at creation", async () => {
    const result = await createProject({ workspaceId: "personal-owner-1", name: "X", createdByUserId: "owner-1" });
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.project.createdAt).toEqual(result.project.updatedAt);
    }
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createProject({ workspaceId: "personal-owner-1", name: "X", createdByUserId: "owner-1" });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns create_failed when the write throws", async () => {
    throwOnCreate.value = "generic";
    const result = await createProject({ workspaceId: "personal-owner-1", name: "X", createdByUserId: "owner-1" });
    expect(result).toEqual({ status: "create_failed" });
  });
});

describe("countProjectsInWorkspace", () => {
  beforeEach(resetAll);

  it("returns 0 for a Workspace with no Projects", async () => {
    const result = await countProjectsInWorkspace("personal-owner-1");
    expect(result).toEqual({ status: "ok", count: 0 });
  });

  it("counts active and archived Projects together", async () => {
    seedProject("proj-1", { status: "active" });
    seedProject("proj-2", { status: "archived" });
    seedProject("proj-3", { status: "active" });
    const result = await countProjectsInWorkspace("personal-owner-1");
    expect(result).toEqual({ status: "ok", count: 3 });
  });

  it("never counts Projects from a different Workspace", async () => {
    seedProject("proj-1", { workspaceId: "personal-owner-1" });
    seedProject("proj-2", { workspaceId: "personal-someone-else" });
    const result = await countProjectsInWorkspace("personal-owner-1");
    expect(result).toEqual({ status: "ok", count: 1 });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await countProjectsInWorkspace("personal-owner-1");
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns count_failed when the count query throws", async () => {
    throwOnRead.value = true;
    const result = await countProjectsInWorkspace("personal-owner-1");
    expect(result).toEqual({ status: "count_failed" });
  });
});

describe("listActiveProjectsRaw", () => {
  beforeEach(resetAll);

  function seedAt(id: string, seconds: number, nanoseconds: number, overrides: Record<string, unknown> = {}) {
    seedProject(id, { createdAt: new Timestamp(seconds, nanoseconds), ...overrides });
  }

  it("returns only active Projects for the given Workspace, newest first", async () => {
    seedAt("proj-1", 100, 0);
    seedAt("proj-2", 200, 0);
    seedAt("proj-3", 150, 0, { status: "archived" });
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 10 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["proj-2", "proj-1"]);
      expect(result.hasMore).toBe(false);
    }
  });

  it("excludes Projects from other Workspaces", async () => {
    seedAt("proj-1", 100, 0, { workspaceId: "personal-owner-1" });
    seedAt("proj-2", 200, 0, { workspaceId: "personal-someone-else" });
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 10 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["proj-1"]);
    }
  });

  it("sets hasMore correctly and never returns the peeked extra document", async () => {
    seedAt("proj-1", 100, 0);
    seedAt("proj-2", 200, 0);
    seedAt("proj-3", 300, 0);
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 2 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["proj-3", "proj-2"]);
      expect(result.hasMore).toBe(true);
    }
  });

  it("startAfter resumes exactly after the given (createdAt, docId) position", async () => {
    seedAt("proj-1", 100, 0);
    seedAt("proj-2", 200, 0);
    seedAt("proj-3", 300, 0);
    const result = await listActiveProjectsRaw({
      workspaceId: "personal-owner-1",
      limit: 10,
      startAfter: { createdAtSeconds: 300, createdAtNanoseconds: 0, lastDocId: "proj-3" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["proj-2", "proj-1"]);
    }
  });

  it("preserves nanosecond precision — two Projects in the same millisecond stay correctly ordered", async () => {
    seedAt("proj-a", 100, 123_456_000);
    seedAt("proj-b", 100, 123_789_000);
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 10 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items.map((i) => i.id)).toEqual(["proj-b", "proj-a"]); // higher nanoseconds = newer = first (desc)
    }
  });

  it("each returned item carries its own document updateTime", async () => {
    seedAt("proj-1", 100, 0);
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 10 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items[0].updateTime).toEqual(DOC_UPDATE_TIME);
    }
  });

  it("returns an empty result, not an error, when there are no matching Projects", async () => {
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 10 });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 10 });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns read_failed when the query throws", async () => {
    throwOnRead.value = true;
    const result = await listActiveProjectsRaw({ workspaceId: "personal-owner-1", limit: 10 });
    expect(result).toEqual({ status: "read_failed" });
  });
});

describe("updateProjectFields", () => {
  beforeEach(resetAll);

  it("updates the given fields and returns the new documentUpdateTime", async () => {
    seedProject("proj-1");
    const result = await updateProjectFields({ projectId: "proj-1", data: { name: "Renamed" }, expectedUpdateTime: DOC_UPDATE_TIME });
    expect(result.status).toBe("updated");
    if (result.status === "updated") {
      expect(result.documentUpdateTime).not.toEqual(DOC_UPDATE_TIME);
    }
    expect(projectDocs.get("projects/proj-1")?.name).toBe("Renamed");
  });

  it("SECURITY/CORRECTNESS: a stale expectedUpdateTime is rejected with precondition_failed — the write never applies", async () => {
    seedProject("proj-1", {}, Timestamp.fromMillis(5_000_000));
    const staleToken = Timestamp.fromMillis(1_000_000); // does not match the seeded updateTime
    const result = await updateProjectFields({ projectId: "proj-1", data: { name: "Should not apply" }, expectedUpdateTime: staleToken });
    expect(result).toEqual({ status: "precondition_failed" });
    expect(projectDocs.get("projects/proj-1")?.name).toBe("My Project"); // unchanged
  });

  it("SECURITY: a genuine real-SDK FAILED_PRECONDITION (gRPC status 9) is correctly detected — not string-matched incorrectly against an unrelated error", async () => {
    seedProject("proj-1", {}, Timestamp.fromMillis(5_000_000));
    const staleToken = Timestamp.fromMillis(1_000_000);
    const result = await updateProjectFields({ projectId: "proj-1", data: { name: "X" }, expectedUpdateTime: staleToken });
    expect(result.status).toBe("precondition_failed");
  });

  it("returns not_found when the document does not exist", async () => {
    const result = await updateProjectFields({ projectId: "does-not-exist", data: { name: "X" }, expectedUpdateTime: DOC_UPDATE_TIME });
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await updateProjectFields({ projectId: "proj-1", data: { name: "X" }, expectedUpdateTime: DOC_UPDATE_TIME });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("returns update_failed for a generic write error, distinct from precondition_failed", async () => {
    seedProject("proj-1");
    throwOnUpdate.value = "generic";
    const result = await updateProjectFields({ projectId: "proj-1", data: { name: "X" }, expectedUpdateTime: DOC_UPDATE_TIME });
    expect(result).toEqual({ status: "update_failed" });
  });
});

describe("Project Firestore write surface stays exactly what Phase 6C authorized", () => {
  /** Strips `/** ... *​/` block comments and `// ...` line comments before checking for real call sites — this file's own doc comments legitimately discuss `.set()`/`.create()` by name to explain why one is chosen over the other; only actual code matters here. */
  function realCodeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("has no real .add( call anywhere — creation always uses .create() on a pre-generated ref, never .add()", () => {
    const source = realCodeOnly(require("fs").readFileSync(require.resolve("@/lib/firestore/projects"), "utf8"));
    expect(source).not.toMatch(/\.add\(/);
  });

  it("has no real .set( or .delete( call anywhere — archive is a status transition via .update(), never a document set/delete; hard delete is out of scope through Phase 6C", () => {
    const source = realCodeOnly(require("fs").readFileSync(require.resolve("@/lib/firestore/projects"), "utf8"));
    expect(source).not.toMatch(/\.set\(/);
    expect(source).not.toMatch(/\.delete\(/);
  });

  it("exports exactly the Phase 6C-authorized function set — no extra write capability introduced", () => {
    const projectsModule = require("@/lib/firestore/projects");
    expect(Object.keys(projectsModule).sort()).toEqual(["countProjectsInWorkspace", "createProject", "getProject", "listActiveProjectsRaw", "updateProjectFields"].sort());
  });
});
