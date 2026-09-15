/**
 * Project/Research Assignment (D5, §6.8) — the two ASSIGNMENT-shaped audit
 * events through the reader, the client parser, and the audit UI. Same
 * `FakeQuery` harness as `listWorkspaceAuditEventsResearchSnapshot.spec.ts`.
 * Every "never surfaced" claim sits beside the positive control that the
 * row IS emitted with exactly its allowed fields.
 */

class FakeTimestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number = 0
  ) {}
  toDate() {
    return new Date(this.seconds * 1000);
  }
}
const DOC_ID_SENTINEL = Symbol("documentId");
jest.mock("firebase-admin/firestore", () => ({ Timestamp: FakeTimestamp, FieldPath: { documentId: () => DOC_ID_SENTINEL } }));

const mockResolveWorkspaceReviewerDisplayNames = jest.fn();
jest.mock("../workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: (...args: unknown[]) => mockResolveWorkspaceReviewerDisplayNames(...args),
}));

type FakeDoc = { id: string; data: Record<string, unknown> };
let eventDocs: FakeDoc[] = [];
class FakeQuery {
  constructor(private filters: Array<{ field: string; value: unknown }> = []) {}
  where(field: string, _op: string, value: unknown) {
    return new FakeQuery([...this.filters, { field, value }]);
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
    const docs = eventDocs.filter((d) => this.filters.every((f) => d.data[f.field] === f.value));
    return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
  }
}
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return { collection: () => new FakeQuery() };
  },
}));
const mockedLogger = { warn: jest.fn(), error: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { listWorkspaceAuditEvents } from "../listWorkspaceAuditEvents";
import { buildWorkspaceMembershipEventDocData } from "../workspaceMembershipEvents";
import { fetchWorkspaceAuditEvents } from "@/lib/client/workspaceTeamClient";

const WS_ID = "ws-1";
const AT = new FakeTimestamp(1723600000, 0);
const AT_ISO = new Date(1723600000 * 1000).toISOString();

function projectEvent(id: string, overrides: Record<string, unknown> = {}): FakeDoc {
  return { id, data: { eventType: "workspace_project_assignees_changed", workspaceId: WS_ID, actorUid: "actor-1", projectId: "proj-1", projectName: "Due Diligence", addedUids: ["member-1"], removedUids: ["viewer-1"], at: AT, ...overrides } };
}
function researchEvent(id: string, overrides: Record<string, unknown> = {}): FakeDoc {
  return { id, data: { eventType: "workspace_research_assignee_changed", workspaceId: WS_ID, actorUid: "actor-1", projectId: "proj-1", projectName: "Due Diligence", runId: "run-1", runQuestion: "What is the TAM?", previousAssigneeUid: null, assigneeUid: "member-1", at: AT, ...overrides } };
}

beforeEach(() => {
  eventDocs = [];
  mockedLogger.warn.mockClear();
  mockResolveWorkspaceReviewerDisplayNames.mockReset();
  mockResolveWorkspaceReviewerDisplayNames.mockImplementation(async (_ws: string, uids: string[], fallback: string) => {
    const names: Record<string, string> = { "actor-1": "Amina", "member-1": "Bao", "viewer-1": "Chidi" };
    return new Map(uids.map((u) => [u, names[u] ?? fallback]));
  });
});

describe("writer builder", () => {
  it("builds both assignment-shaped docs with exactly the allowed identity (uids, snapshots, nullable Project pair)", () => {
    const at = AT as never;
    expect(buildWorkspaceMembershipEventDocData({ eventType: "workspace_project_assignees_changed", actorUid: "a", workspaceId: WS_ID, projectId: "p", projectName: "P", addedUids: ["x"], removedUids: [], at })).toEqual({
      eventType: "workspace_project_assignees_changed",
      actorUid: "a",
      workspaceId: WS_ID,
      projectId: "p",
      projectName: "P",
      addedUids: ["x"],
      removedUids: [],
      at,
    });
    const research = buildWorkspaceMembershipEventDocData({ eventType: "workspace_research_assignee_changed", actorUid: "a", workspaceId: WS_ID, projectId: null, projectName: null, runId: "r", runQuestion: "Q?", previousAssigneeUid: "x", assigneeUid: null, at });
    expect(research).toEqual({ eventType: "workspace_research_assignee_changed", actorUid: "a", workspaceId: WS_ID, projectId: null, projectName: null, runId: "r", runQuestion: "Q?", previousAssigneeUid: "x", assigneeUid: null, at });
    expect(Object.keys(research)).not.toContain("targetUid");
    expect(Object.keys(research)).not.toContain("displayName");
  });
});

describe("reader — projection (allow-list, display names only)", () => {
  it("Project event ⇒ project.name + added/removed DISPLAY NAMES; no projectId, no uids", async () => {
    eventDocs = [projectEvent("e1")];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items).toEqual([{ eventType: "workspace_project_assignees_changed", occurredAt: AT_ISO, actor: { displayName: "Amina" }, project: { name: "Due Diligence" }, added: [{ displayName: "Bao" }], removed: [{ displayName: "Chidi" }], repair: false }]);
    const json = JSON.stringify(r.items);
    for (const leak of ["proj-1", "member-1", "viewer-1", "actor-1", "addedUids"]) expect(json).not.toContain(leak);
  });

  it("research event (filed) ⇒ project.name, research.question, previous/new DISPLAY NAMES; no runId/projectId/uids", async () => {
    eventDocs = [researchEvent("e1", { previousAssigneeUid: "viewer-1", assigneeUid: "member-1" })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items).toEqual([{ eventType: "workspace_research_assignee_changed", occurredAt: AT_ISO, actor: { displayName: "Amina" }, project: { name: "Due Diligence" }, research: { question: "What is the TAM?" }, previousAssignee: { displayName: "Chidi" }, assignee: { displayName: "Bao" }, repair: false }]);
    const json = JSON.stringify(r.items);
    for (const leak of ["run-1", "proj-1", "member-1", "viewer-1", "actor-1"]) expect(json).not.toContain(leak);
  });

  it("research event (Unfiled) ⇒ project: null, and a cleared assignee ⇒ assignee: null", async () => {
    eventDocs = [researchEvent("e1", { projectId: null, projectName: null, previousAssigneeUid: "member-1", assigneeUid: null })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items[0]).toMatchObject({ project: null, previousAssignee: { displayName: "Bao" }, assignee: null });
  });

  it("assignee uids are resolved through the SAME bounded batch as actor/target (never per-event)", async () => {
    eventDocs = [projectEvent("e1"), researchEvent("e2", { previousAssigneeUid: "viewer-1" })];
    await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(mockResolveWorkspaceReviewerDisplayNames).toHaveBeenCalledTimes(2); // actor batch + target batch, page-wide
    const requested = mockResolveWorkspaceReviewerDisplayNames.mock.calls[1][1] as string[];
    expect(new Set(requested)).toEqual(new Set(["actor-1", "member-1", "viewer-1"]));
  });

  it("a uid with no evidence gets the fixed fallback label, never the raw uid", async () => {
    eventDocs = [projectEvent("e1", { addedUids: ["ghost-uid"], removedUids: [] })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    const added = (r.items[0] as { added: { displayName: string }[] }).added[0].displayName;
    expect(added).not.toBe("ghost-uid");
    expect(added.length).toBeGreaterThan(0);
  });
});

describe("reader — validation (skip, never repair; positive control: the complete row is emitted)", () => {
  it.each([
    ["missing projectName", () => projectEvent("bad", { projectName: "" })],
    ["non-array addedUids", () => projectEvent("bad", { addedUids: "member-1" })],
    ["empty-string uid in removedUids", () => projectEvent("bad", { removedUids: [""] })],
  ])("Project event with %s is skipped", async (_l, mk) => {
    eventDocs = [projectEvent("ok"), mk()];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items).toHaveLength(1);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["projectId null but projectName a string (never a writer shape)", () => researchEvent("bad", { projectId: null, projectName: "Stray" })],
    ["non-string projectId", () => researchEvent("bad", { projectId: 42, projectName: null })],
    ["missing runQuestion", () => researchEvent("bad", { runQuestion: "" })],
    ["missing runId", () => researchEvent("bad", { runId: undefined })],
    ["non-string assigneeUid", () => researchEvent("bad", { assigneeUid: 42 })],
  ])("research event with %s is skipped", async (_l, mk) => {
    eventDocs = [researchEvent("ok"), mk()];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items).toHaveLength(1);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("neither assignment event is forced through the member schema (no targetUid / previousRole required)", async () => {
    eventDocs = [projectEvent("e1"), researchEvent("e2")];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items).toHaveLength(2);
    expect(JSON.stringify(r.items)).not.toContain("previousRole");
  });
});

describe("client parser", () => {
  const ok = (events: unknown[]) => ({ ok: true, status: 200, json: async () => ({ ok: true, events, hasMore: false }) });
  const projectItem = { eventType: "workspace_project_assignees_changed", occurredAt: "2026-09-14T00:00:00.000Z", actor: { displayName: "Amina" }, project: { name: "Due Diligence" }, added: [{ displayName: "Bao" }], removed: [], repair: false };
  const researchItem = { eventType: "workspace_research_assignee_changed", occurredAt: "2026-09-14T00:00:00.000Z", actor: { displayName: "Amina" }, project: null, research: { question: "Q?" }, previousAssignee: null, assignee: { displayName: "Bao" }, repair: false };

  it("accepts both assignment DTOs, including the nullable slots", async () => {
    mockedAuthedFetch.mockResolvedValue(ok([projectItem, researchItem]));
    expect(await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: WS_ID })).toEqual({ status: "ok", events: [projectItem, researchItem], hasMore: false });
  });

  it("rejects malformed assignment DTOs (positive control above)", async () => {
    const bad = [
      { ...projectItem, project: { name: "" } },
      { ...projectItem, added: "Bao" },
      { ...projectItem, removed: [{ name: "x" }] },
      { ...researchItem, research: { question: "" } },
      { ...researchItem, project: { name: "" } },
      { ...researchItem, assignee: "Bao" },
      { ...researchItem, previousAssignee: undefined },
      { ...researchItem, repair: undefined },
      { ...projectItem, repair: "yes" },
      { ...researchItem, project: { unavailable: true, id: "proj-1" } },
      { ...researchItem, project: { unavailable: "yes" } },
    ];
    for (const item of bad) {
      mockedAuthedFetch.mockResolvedValue(ok([item]));
      expect(await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: WS_ID })).toEqual({ status: "error" });
    }
  });
});

describe("audit UI", () => {
  const source = readFileSync(join(__dirname, "..", "..", "..", "components", "workspace", "WorkspaceAuditLogShell.tsx"), "utf8");

  it("both new branches sit BEFORE the final else (which still renders 'Role changed')", () => {
    const projectBranch = source.indexOf('event.eventType === "workspace_project_assignees_changed"');
    const researchBranch = source.indexOf('event.eventType === "workspace_research_assignee_changed"');
    const finalElse = source.indexOf("Role changed");
    expect(projectBranch).toBeGreaterThan(-1);
    expect(researchBranch).toBeGreaterThan(projectBranch);
    expect(researchBranch).toBeLessThan(finalElse);
    expect(source).toMatch(/Project assignees changed/);
    expect(source).toMatch(/Research assignee changed/);
    expect(source).not.toMatch(/event\.addedUids|event\.assigneeUid|event\.runId|event\.projectId/);
  });

  it("RENDER: both cards render with display names, and an unknown-shaped (member) event would NOT have rendered as either", async () => {
    // A STABLE auth value — a fresh `user` object per render would re-trigger
    // the shell's load effect forever (its `loadFirstPage` depends on `user`).
    const stableAuth = { user: { uid: "u" }, loading: false, authReady: true };
    jest.doMock("@/components/AuthProvider", () => ({ useAuth: () => stableAuth }));
    jest.doMock("next/link", () => {
      const MockLink = ({ href, children }: { href: string; children: React.ReactNode }) => require("react").createElement("a", { href }, children);
      return { __esModule: true, default: MockLink };
    });
    jest.doMock("@/lib/client/workspaceTeamClient", () => ({
      fetchWorkspaceAuditEvents: async () => ({
        status: "ok",
        hasMore: false,
        events: [
          { eventType: "workspace_project_assignees_changed", occurredAt: AT_ISO, actor: { displayName: "Amina" }, project: { name: "Due Diligence" }, added: [{ displayName: "Bao" }], removed: [{ displayName: "Chidi" }], repair: false },
          { eventType: "workspace_research_assignee_changed", occurredAt: AT_ISO, actor: { displayName: "Amina" }, project: null, research: { question: "What is the TAM?" }, previousAssignee: { displayName: "Chidi" }, assignee: null, repair: false },
          { eventType: "workspace_member_role_changed", occurredAt: AT_ISO, actor: { displayName: "Amina" }, target: { displayName: "Dev" }, previousRole: "member", newRole: "admin" },
        ],
      }),
    }));
    const { default: Shell } = await import("@/components/workspace/WorkspaceAuditLogShell");
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Shell, { workspaceId: WS_ID, workspaceName: "Acme" } as never));
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Project assignees changed");
    expect(text).toContain("Added: ");
    expect(text).toContain("Bao");
    expect(text).toContain("Removed: ");
    expect(text).toContain("Chidi");
    expect(text).toContain("Research assignee changed");
    expect(text).toContain("(Unfiled)");
    expect(text).toContain("no longer assigned.");
    expect(text).toContain("Previously: ");
    // The member event rendered as its OWN card — the new branches did not swallow it.
    expect(text).toContain("Role changed");
    expect((text.match(/Project assignees changed/g) ?? []).length).toBe(1);
    expect((text.match(/Research assignee changed/g) ?? []).length).toBe(1);
  });
});
