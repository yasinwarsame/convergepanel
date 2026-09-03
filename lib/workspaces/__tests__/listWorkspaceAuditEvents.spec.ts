/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — `listWorkspaceAuditEvents()`
 * tests. Firestore query is faked in-memory (mirrors
 * `listTeamWorkspaceRuns.spec.ts`'s `FakeQuery` pattern); identity
 * resolution is mocked directly (its own behavior is covered by
 * `workspaceReviewerIdentity.spec.ts`).
 */

class FakeTimestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number = 0
  ) {}
  toDate() {
    return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000));
  }
}
const DOC_ID_SENTINEL = Symbol("documentId");
class FakeFieldPath {
  static documentId() {
    return DOC_ID_SENTINEL;
  }
}
jest.mock("firebase-admin/firestore", () => ({
  Timestamp: FakeTimestamp,
  FieldPath: FakeFieldPath,
}));

const mockResolveWorkspaceReviewerDisplayNames = jest.fn();
jest.mock("../workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: (...args: unknown[]) => mockResolveWorkspaceReviewerDisplayNames(...args),
}));

type FakeDoc = { id: string; data: Record<string, unknown> };

function orderingKey(doc: FakeDoc, field: string | symbol): [number, number] | string {
  if (field === DOC_ID_SENTINEL) return doc.id;
  const v = doc.data[field as string];
  if (v instanceof FakeTimestamp) return [v.seconds, v.nanoseconds];
  return String(v ?? "");
}
function compareKeys(a: [number, number] | string, b: [number, number] | string): number {
  if (Array.isArray(a) && Array.isArray(b)) return a[0] - b[0] || a[1] - b[1];
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

class FakeQuery {
  constructor(
    private allDocs: FakeDoc[],
    private filters: Array<{ field: string; op: string; value: unknown }> = [],
    private orders: Array<{ field: string | symbol; dir: "asc" | "desc" }> = [],
    private startAfterVals?: unknown[],
    private limitN?: number
  ) {}
  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.allDocs, [...this.filters, { field, op, value }], this.orders, this.startAfterVals, this.limitN);
  }
  orderBy(field: string | symbol, dir: "asc" | "desc" = "asc") {
    return new FakeQuery(this.allDocs, this.filters, [...this.orders, { field, dir }], this.startAfterVals, this.limitN);
  }
  startAfter(...vals: unknown[]) {
    return new FakeQuery(this.allDocs, this.filters, this.orders, vals, this.limitN);
  }
  limit(n: number) {
    return new FakeQuery(this.allDocs, this.filters, this.orders, this.startAfterVals, n);
  }
  async get() {
    let result = this.allDocs.filter((d) => this.filters.every((f) => f.op === "==" && d.data[f.field] === f.value));
    result = [...result].sort((a, b) => {
      for (const o of this.orders) {
        const cmp = compareKeys(orderingKey(a, o.field), orderingKey(b, o.field));
        if (cmp !== 0) return o.dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
    if (this.startAfterVals) {
      const startKeys = this.orders.map((o, i) => {
        const raw = this.startAfterVals![i];
        if (o.field === DOC_ID_SENTINEL) return String(raw);
        if (raw instanceof FakeTimestamp) return [raw.seconds, raw.nanoseconds] as [number, number];
        return raw;
      });
      const idx = result.findIndex((d) => this.orders.every((o, i) => compareKeys(orderingKey(d, o.field), startKeys[i] as any) === 0));
      result = idx === -1 ? [] : result.slice(idx + 1);
    }
    if (this.limitN != null) result = result.slice(0, this.limitN);
    lastRawFetchedDocCount = result.length;
    return { docs: result.map((d) => ({ id: d.id, data: () => d.data })) };
  }
}

// Records the RAW count returned from the fake Firestore layer's own
// `get()` — distinct from the function's final response-sliced `items`
// length. A query missing `.limit()` would return every matching doc
// here even if the function later slices its response down to `limit`;
// this is the only way to prove the bound lives in the query itself, not
// merely in response shaping (see test N below).
let lastRawFetchedDocCount = 0;

let eventDocs: FakeDoc[] = [];
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "workspaceMembershipEvents") return new FakeQuery(eventDocs);
    throw new Error(`unexpected collection ${name}`);
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));

import { listWorkspaceAuditEvents } from "../listWorkspaceAuditEvents";

const WS_ID = "ws-1";

function evt(id: string, overrides: Partial<Record<string, unknown>> = {}): FakeDoc {
  return {
    id,
    data: {
      eventType: "workspace_member_removed",
      workspaceId: WS_ID,
      actorUid: "actor-1",
      targetUid: "target-1",
      previousRole: "member",
      at: new FakeTimestamp(1723600000, 0),
      ...overrides,
    },
  };
}

beforeEach(() => {
  eventDocs = [];
  mockResolveWorkspaceReviewerDisplayNames.mockReset();
  mockResolveWorkspaceReviewerDisplayNames.mockResolvedValue(new Map());
});

describe("listWorkspaceAuditEvents — query scope", () => {
  it("K. exact workspaceId predicate — a foreign-workspace event never appears", async () => {
    eventDocs = [evt("e1", { workspaceId: WS_ID }), evt("e2", { workspaceId: "other-ws" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.items).toHaveLength(1);
  });

  it("N. no unbounded query — limit+1 is the actual Firestore-level cap, not just response slicing (proven via the fake's own raw fetched-doc count, which response-slicing alone could never mask)", async () => {
    eventDocs = Array.from({ length: 100 }, (_, i) => evt(`e${i}`, { at: new FakeTimestamp(1723600000 - i, 0) }));
    lastRawFetchedDocCount = 0;
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 5 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.items).toHaveLength(5);
      expect(r.hasMore).toBe(true);
    }
    // The RAW fetch itself must be bounded to limit+1 (6), never all 100 —
    // this is what a missing `.limit()` call on the real query would break,
    // even though the final `items` slice would look identical either way.
    expect(lastRawFetchedDocCount).toBe(6);
  });

  it("O. newest-first ordering", async () => {
    eventDocs = [
      evt("old", { at: new FakeTimestamp(100, 0), targetUid: "old-target" }),
      evt("new", { at: new FakeTimestamp(200, 0), targetUid: "new-target" }),
    ];
    mockResolveWorkspaceReviewerDisplayNames.mockResolvedValue(new Map([["old-target", "Old"], ["new-target", "New"]]));
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(new Date(r.items[0].occurredAt).getTime()).toBeGreaterThan(new Date(r.items[1].occurredAt).getTime());
    }
  });

  it("P. deterministic tie ordering via document-id secondary key when timestamps collide — inserted in ASCENDING doc-id order (a-doc before b-doc) so a stable sort on `at` ALONE would preserve that order; the doc-id DESC tie-breaker must actively reverse it", async () => {
    eventDocs = [
      evt("a-doc", { at: new FakeTimestamp(100, 0), targetUid: "target-a" }),
      evt("b-doc", { at: new FakeTimestamp(100, 0), targetUid: "target-b" }),
    ];
    mockResolveWorkspaceReviewerDisplayNames.mockResolvedValue(new Map([["target-a", "A"], ["target-b", "B"]]));
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.items).toHaveLength(2);
      // doc id DESC -> "b-doc" (higher) must come first, opposite of insertion order.
      expect(r.items[0].target.displayName).toBe("B");
      expect(r.items[1].target.displayName).toBe("A");
    }
  });

  it("Q. cursor continuation has no duplicate/skip across two pages", async () => {
    eventDocs = Array.from({ length: 10 }, (_, i) => evt(`e${i}`, { at: new FakeTimestamp(1723600000 - i, 0) }));
    const page1 = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 4 });
    expect(page1.status).toBe("ok");
    if (page1.status !== "ok" || !page1.nextCursor) throw new Error("expected page1 with cursor");
    const page2 = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 4, cursorRaw: page1.nextCursor });
    expect(page2.status).toBe("ok");
    if (page2.status !== "ok") throw new Error("expected page2 ok");
    const allTimes = [...page1.items, ...page2.items].map((e) => e.occurredAt);
    expect(new Set(allTimes).size).toBe(allTimes.length); // no duplicates
  });

  it("R. malformed cursor -> invalid_cursor", async () => {
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20, cursorRaw: "not-a-real-cursor" });
    expect(r).toEqual({ status: "invalid_cursor" });
  });
});

describe("listWorkspaceAuditEvents — DTO allow-list", () => {
  it("S/T/U/V/W. output never contains actorUid, targetUid, workspaceId, or a raw event doc id", async () => {
    eventDocs = [evt("evt-doc-id-123")];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const serialized = JSON.stringify(r.items);
      expect(serialized).not.toMatch(/actor-1|target-1|evt-doc-id-123/);
      expect(serialized).not.toMatch(/"workspaceId"/);
      expect(Object.keys(r.items[0]).sort()).toEqual(["actor", "eventType", "occurredAt", "previousRole", "target"]);
    }
  });
});

describe("listWorkspaceAuditEvents — identity", () => {
  it("Y/Z. actor and target resolve to human display names via the batched resolver", async () => {
    eventDocs = [evt("e1", { actorUid: "actor-a", targetUid: "target-b" })];
    mockResolveWorkspaceReviewerDisplayNames.mockImplementation((_ws: string, _uids: string[], fallback: string) => {
      const m = new Map<string, string>();
      m.set("actor-a", "Alice Owner");
      m.set("target-b", "Bob Member");
      return Promise.resolve(m);
    });
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.items[0].actor.displayName).toBe("Alice Owner");
      expect(r.items[0].target.displayName).toBe("Bob Member");
    }
  });

  it("AC/AD. missing actor -> Unknown user, missing target -> Unknown member (distinct fallback labels)", async () => {
    eventDocs = [evt("e1")];
    mockResolveWorkspaceReviewerDisplayNames.mockImplementation((_ws: string, _uids: string[], fallback: string) => Promise.resolve(new Map()));
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.items[0].actor.displayName).toBe("Unknown user");
      expect(r.items[0].target.displayName).toBe("Unknown member");
    }
  });

  it("AF. multiple events sharing the same identity are resolved via ONE batched call per role, not per event", async () => {
    eventDocs = [evt("e1", { actorUid: "same-actor" }), evt("e2", { actorUid: "same-actor" }), evt("e3", { actorUid: "same-actor" })];
    await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    // Two calls total (one for actors, one for targets) regardless of page size — never N+1.
    expect(mockResolveWorkspaceReviewerDisplayNames).toHaveBeenCalledTimes(2);
  });
});

describe("listWorkspaceAuditEvents — event normalization / malformed rows", () => {
  it("AH/AI/AJ/AK/AL. workspace_member_removed normalizes correctly for every valid previous role", async () => {
    eventDocs = [
      evt("e-admin", { previousRole: "admin", targetUid: "t-admin" }),
      evt("e-member", { previousRole: "member", targetUid: "t-member" }),
      evt("e-reviewer", { previousRole: "reviewer", targetUid: "t-reviewer" }),
      evt("e-viewer", { previousRole: "viewer", targetUid: "t-viewer" }),
    ];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const roles = r.items.map((i) => i.previousRole).sort();
      expect(roles).toEqual(["admin", "member", "reviewer", "viewer"]);
    }
  });

  it("AM/AO. malformed role fails closed — the event is skipped, never rendered with a manufactured/owner role", async () => {
    eventDocs = [evt("bad-role", { previousRole: "owner" }), evt("good", { previousRole: "member" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.items).toHaveLength(1);
      expect(r.items[0].previousRole).toBe("member");
    }
  });

  it("AN. timestamp normalizes to a valid ISO string", async () => {
    eventDocs = [evt("e1", { at: new FakeTimestamp(1723600000, 0) })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(Number.isNaN(Date.parse(r.items[0].occurredAt))).toBe(false);
  });

  it("AO (continued). a malformed event (missing actorUid) does not crash the page and does not overexpose — it's silently skipped", async () => {
    eventDocs = [evt("malformed", { actorUid: undefined }), evt("good2", { targetUid: "t-good2" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.items).toHaveLength(1);
  });

  it("wrong eventType is skipped (forward-compatible fail-closed for a future event type this reader doesn't understand yet)", async () => {
    eventDocs = [evt("other", { eventType: "some_future_event" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.items).toHaveLength(0);
  });

  it("empty result set -> ok, items: [], hasMore: false", async () => {
    eventDocs = [];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r).toEqual({ status: "ok", items: [], hasMore: false });
  });
});

describe("listWorkspaceAuditEvents — Phase TEAM-MGMT-12C: workspace_ownership_transferred", () => {
  function transferEvt(id: string, overrides: Partial<Record<string, unknown>> = {}): FakeDoc {
    return evt(id, { eventType: "workspace_ownership_transferred", ...overrides });
  }

  it("a workspace_ownership_transferred row normalizes correctly into the DTO", async () => {
    eventDocs = [transferEvt("e1", { actorUid: "old-owner", targetUid: "new-owner", previousRole: "admin" })];
    mockResolveWorkspaceReviewerDisplayNames.mockResolvedValue(new Map([["old-owner", "Olivia Owner"], ["new-owner", "Adam Admin"]]));
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toEqual({
      eventType: "workspace_ownership_transferred",
      occurredAt: expect.any(String),
      actor: { displayName: "Olivia Owner" },
      target: { displayName: "Adam Admin" },
      previousRole: "admin",
    });
  });

  it("normalizes correctly for every valid previous role (admin/member/reviewer/viewer)", async () => {
    eventDocs = [
      transferEvt("e-admin", { previousRole: "admin", targetUid: "t-admin" }),
      transferEvt("e-member", { previousRole: "member", targetUid: "t-member" }),
      transferEvt("e-reviewer", { previousRole: "reviewer", targetUid: "t-reviewer" }),
      transferEvt("e-viewer", { previousRole: "viewer", targetUid: "t-viewer" }),
    ];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const roles = r.items.map((i) => i.previousRole).sort();
    expect(roles).toEqual(["admin", "member", "reviewer", "viewer"]);
    expect(r.items.every((i) => i.eventType === "workspace_ownership_transferred")).toBe(true);
  });

  it("malformed ownership-transfer row (previousRole: 'owner') is skipped, not crashed, matching the existing malformed-row policy", async () => {
    eventDocs = [transferEvt("bad", { previousRole: "owner" }), transferEvt("good", { previousRole: "member" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0].previousRole).toBe("member");
  });

  it("malformed ownership-transfer row (missing actorUid) is skipped", async () => {
    eventDocs = [transferEvt("bad", { actorUid: undefined }), transferEvt("good", { targetUid: "t-good" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(1);
  });

  it("a mixed page (some workspace_member_removed, some workspace_ownership_transferred) normalizes both correctly, newest-first, with actor/target identity batched across BOTH event types in one set of calls", async () => {
    eventDocs = [
      evt("removed-1", { eventType: "workspace_member_removed", at: new FakeTimestamp(100, 0), actorUid: "actor-a", targetUid: "target-a" }),
      transferEvt("transferred-1", { at: new FakeTimestamp(200, 0), actorUid: "actor-b", targetUid: "target-b" }),
    ];
    mockResolveWorkspaceReviewerDisplayNames.mockImplementation((_ws: string, uids: string[]) => {
      const m = new Map<string, string>();
      for (const uid of uids) m.set(uid, `Name(${uid})`);
      return Promise.resolve(m);
    });
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(2);
    // newest-first: the transfer (at: 200) before the removal (at: 100).
    expect(r.items[0].eventType).toBe("workspace_ownership_transferred");
    expect(r.items[1].eventType).toBe("workspace_member_removed");
    // Both events' actor/target uids resolved via the SAME two batched calls (never per-event/per-type).
    expect(mockResolveWorkspaceReviewerDisplayNames).toHaveBeenCalledTimes(2);
    const [actorCallArgs] = mockResolveWorkspaceReviewerDisplayNames.mock.calls;
    const uidsPassedToFirstCall = actorCallArgs[1] as string[];
    expect(new Set(uidsPassedToFirstCall)).toEqual(new Set(["actor-a", "target-a", "actor-b", "target-b"]));
  });

  it("an unrecognized future eventType is still skipped (forward-compatible), proving the widened check didn't accidentally accept everything", async () => {
    eventDocs = [evt("other", { eventType: "some_future_event" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(0);
  });
});

describe("listWorkspaceAuditEvents — Phase 12B: workspace_member_role_changed", () => {
  function roleChangedEvt(id: string, overrides: Partial<Record<string, unknown>> = {}): FakeDoc {
    return evt(id, { eventType: "workspace_member_role_changed", newRole: "reviewer", ...overrides });
  }

  it("a workspace_member_role_changed row normalizes correctly into the DTO, including newRole", async () => {
    eventDocs = [roleChangedEvt("e1", { actorUid: "owner-1", targetUid: "member-1", previousRole: "member", newRole: "admin" })];
    mockResolveWorkspaceReviewerDisplayNames.mockResolvedValue(new Map([["owner-1", "Olivia Owner"], ["member-1", "Mo Member"]]));
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toEqual({
      eventType: "workspace_member_role_changed",
      occurredAt: expect.any(String),
      actor: { displayName: "Olivia Owner" },
      target: { displayName: "Mo Member" },
      previousRole: "member",
      newRole: "admin",
    });
  });

  it("normalizes correctly for every valid (previousRole, newRole) combination", async () => {
    eventDocs = [
      roleChangedEvt("e-1", { previousRole: "admin", newRole: "member", targetUid: "t-1" }),
      roleChangedEvt("e-2", { previousRole: "member", newRole: "reviewer", targetUid: "t-2" }),
      roleChangedEvt("e-3", { previousRole: "reviewer", newRole: "viewer", targetUid: "t-3" }),
      roleChangedEvt("e-4", { previousRole: "viewer", newRole: "admin", targetUid: "t-4" }),
    ];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(4);
    expect(r.items.every((i) => i.eventType === "workspace_member_role_changed")).toBe(true);
    const pairs = r.items.map((i) => (i.eventType === "workspace_member_role_changed" ? `${i.previousRole}->${i.newRole}` : "")).sort();
    expect(pairs).toEqual(["admin->member", "member->reviewer", "reviewer->viewer", "viewer->admin"]);
  });

  it("a role-changed row missing newRole is malformed and skipped — the other two event types are unaffected by this requirement", async () => {
    eventDocs = [roleChangedEvt("bad", { newRole: undefined }), evt("good-removed"), roleChangedEvt("good-changed", { newRole: "viewer" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(2);
    expect(r.items.map((i) => i.eventType).sort()).toEqual(["workspace_member_removed", "workspace_member_role_changed"]);
  });

  it("a role-changed row with newRole: 'owner' is malformed and skipped", async () => {
    eventDocs = [roleChangedEvt("bad", { newRole: "owner" }), roleChangedEvt("good", { newRole: "member" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(1);
    if (r.items[0].eventType !== "workspace_member_role_changed") throw new Error("expected role_changed");
    expect(r.items[0].newRole).toBe("member");
  });

  it("a role-changed row with newRole: 123 (non-string) is malformed and skipped", async () => {
    eventDocs = [roleChangedEvt("bad", { newRole: 123 }), roleChangedEvt("good", { newRole: "member" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(1);
  });

  it("a mixed page across all three event types normalizes correctly, newest-first, with actor/target identity batched in one set of calls", async () => {
    eventDocs = [
      evt("removed-1", { eventType: "workspace_member_removed", at: new FakeTimestamp(100, 0), actorUid: "actor-a", targetUid: "target-a" }),
      evt("transferred-1", { eventType: "workspace_ownership_transferred", at: new FakeTimestamp(200, 0), actorUid: "actor-b", targetUid: "target-b" }),
      roleChangedEvt("changed-1", { at: new FakeTimestamp(300, 0), actorUid: "actor-c", targetUid: "target-c", newRole: "viewer" }),
    ];
    mockResolveWorkspaceReviewerDisplayNames.mockImplementation((_ws: string, uids: string[]) => {
      const m = new Map<string, string>();
      for (const uid of uids) m.set(uid, `Name(${uid})`);
      return Promise.resolve(m);
    });
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.eventType)).toEqual(["workspace_member_role_changed", "workspace_ownership_transferred", "workspace_member_removed"]);
    expect(mockResolveWorkspaceReviewerDisplayNames).toHaveBeenCalledTimes(2);
  });
});
