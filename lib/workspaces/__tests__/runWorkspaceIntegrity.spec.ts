/**
 * Phase 4B — validateRunWorkspaceAssociation() tests. Two distinct security
 * invariants under test, matching the module's own doc comment:
 *
 * 1. "True absence is the only legacy state" — property truly missing on
 *    the raw run data is legacy; null/""/whitespace/wrong-type/undefined-
 *    as-owned-property are all present-but-invalid, never legacy.
 * 2. "Never legacy fallback" — every present-but-invalid shape resolves to
 *    `invalid`, never `legacy`, regardless of what the underlying resolver
 *    or Firestore lookup returns.
 *
 * The `(userId, runData)` signature (never a reconstructed
 * `{userId, workspaceId}` object) is itself load-bearing: an object
 * literal with a `workspaceId:` key always creates an own property even
 * when the value is `undefined`, which would silently defeat true-absence
 * detection at every call site. These tests construct `runData` the same
 * way real Firestore data arrives — via property assignment or
 * `Object.defineProperty`, never a literal with an always-present key.
 */

import type { WorkspaceContextResolution } from "@/lib/workspaces/types";

const OWNER_UID = "owner-1";

describe("validateRunWorkspaceAssociation — requester-independence", () => {
  it("the exported function's parameters carry no requester/reviewer/admin identity beyond the run's own owner", async () => {
    const { validateRunWorkspaceAssociation } = await import("@/lib/workspaces/runWorkspaceIntegrity");
    expect(validateRunWorkspaceAssociation.length).toBe(2); // userId, runData — nothing else
  });
});

describe("validateRunWorkspaceAssociation — legacy detection (true absence only)", () => {
  async function load() {
    jest.resetModules();
    const mod = await import("@/lib/workspaces/runWorkspaceIntegrity");
    return mod.validateRunWorkspaceAssociation;
  }

  it("workspaceId property truly absent on runData -> legacy", async () => {
    const validate = await load();
    const runData: Record<string, unknown> = { question: "x" }; // no workspaceId key at all
    const result = await validate(OWNER_UID, runData);
    expect(result).toEqual({ classification: "legacy" });
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["whitespace-only string", "   "],
    ["a number", 12345],
    ["an object", { id: "ws-1" }],
    ["an array", ["ws-1"]],
    ["undefined as an OWNED property (not truly absent)", undefined],
  ])("workspaceId present as %s -> invalid, never legacy", async (_label, value) => {
    const validate = await load();
    const runData: Record<string, unknown> = {};
    Object.defineProperty(runData, "workspaceId", { value, enumerable: true, configurable: true });
    expect(Object.prototype.hasOwnProperty.call(runData, "workspaceId")).toBe(true);

    const result = await validate(OWNER_UID, runData);
    expect(result.classification).toBe("invalid");
    expect(result).not.toEqual({ classification: "legacy" });
  });
});

describe("validateRunWorkspaceAssociation — run_owner_invalid", () => {
  async function load() {
    jest.resetModules();
    const mod = await import("@/lib/workspaces/runWorkspaceIntegrity");
    return mod.validateRunWorkspaceAssociation;
  }

  it("an unparseable owner uid (e.g. containing '/') fails closed before any Firestore read", async () => {
    const validate = await load();
    const result = await validate("bad/uid", { workspaceId: "personal-bad/uid" });
    expect(result).toEqual({ classification: "invalid", reason: "run_owner_invalid" });
  });
});

describe("validateRunWorkspaceAssociation — deterministic_id_mismatch", () => {
  it("workspaceId pointing at a DIFFERENT user's deterministic id -> invalid, no Firestore read attempted", async () => {
    jest.resetModules();
    const getWorkspaceMock = jest.fn();
    jest.doMock("@/lib/firestore/workspaces", () => ({ getWorkspace: getWorkspaceMock }));
    jest.doMock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));
    const mod = await import("@/lib/workspaces/runWorkspaceIntegrity");

    const result = await mod.validateRunWorkspaceAssociation(OWNER_UID, { workspaceId: "personal-someone-else" });
    expect(result).toEqual({ classification: "invalid", reason: "deterministic_id_mismatch" });
    expect(getWorkspaceMock).not.toHaveBeenCalled();
  });
});

describe("validateRunWorkspaceAssociation — resolver outcomes mapped correctly", () => {
  function mockResolver(resolution: WorkspaceContextResolution) {
    jest.resetModules();
    jest.doMock("@/lib/workspaces/workspaceResolver", () => ({
      resolveWorkspaceContextForResource: jest.fn(async () => resolution),
    }));
  }

  async function load() {
    const mod = await import("@/lib/workspaces/runWorkspaceIntegrity");
    return mod.validateRunWorkspaceAssociation;
  }

  const expectedWorkspaceId = `personal-${OWNER_UID}`;

  it("resolver: workspaces_disabled -> invalid/workspaces_disabled", async () => {
    mockResolver({ kind: "workspaces_disabled" });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspaces_disabled" });
  });

  it("resolver: not_found -> invalid/workspace_not_found", async () => {
    mockResolver({ kind: "not_found" });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspace_not_found" });
  });

  it("resolver: lookup_failed -> invalid/workspace_lookup_failed", async () => {
    mockResolver({ kind: "lookup_failed" });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspace_lookup_failed" });
  });

  it("resolver: malformed -> invalid/workspace_malformed", async () => {
    mockResolver({ kind: "malformed" });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspace_malformed" });
  });

  it("resolver: unsupported_workspace_type -> invalid/workspace_wrong_type", async () => {
    mockResolver({ kind: "unsupported_workspace_type" });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspace_wrong_type" });
  });

  it("resolver: legacy (structurally unreachable in practice) -> invalid/malformed_workspace_id, never legacy", async () => {
    mockResolver({ kind: "legacy", context: { mode: "legacy", ownerUserId: OWNER_UID } });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "malformed_workspace_id" });
    expect(result).not.toEqual({ classification: "legacy" });
  });

  it("resolver: resolved + matching owner -> valid", async () => {
    mockResolver({
      kind: "resolved",
      context: { mode: "workspace", workspaceId: expectedWorkspaceId, workspaceType: "personal", ownerUserId: OWNER_UID },
    });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "valid", workspaceId: expectedWorkspaceId });
  });

  it("THREAT — resolver: resolved but Workspace.ownerUserId != run's own userId -> invalid/workspace_owner_mismatch, never valid", async () => {
    mockResolver({
      kind: "resolved",
      context: { mode: "workspace", workspaceId: expectedWorkspaceId, workspaceType: "personal", ownerUserId: "someone-else" },
    });
    const validate = await load();
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspace_owner_mismatch" });
    expect(result.classification).not.toBe("valid");
  });
});

describe("validateRunWorkspaceAssociation — end-to-end through the real Phase 1 resolver (not mocked at that layer)", () => {
  const workspaceDocs = new Map<string, Record<string, unknown>>();

  beforeEach(() => {
    workspaceDocs.clear();
    jest.resetModules();
  });

  function seedWorkspace(id: string, overrides: Record<string, unknown> = {}) {
    workspaceDocs.set(id, {
      schemaVersion: 1,
      id,
      type: "personal",
      name: "Personal Workspace",
      ownerUserId: OWNER_UID,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      ...overrides,
    });
  }

  async function loadWithFlag(enabled: boolean) {
    // `jest.doMock` registrations for a given module path persist across
    // `describe` blocks within the same file until explicitly cleared —
    // `jest.resetModules()` alone only clears the require cache, not the
    // mock-factory registration itself. The earlier "resolver outcomes
    // mapped correctly" block mocks `workspaceResolver` directly; this
    // block deliberately wants the REAL resolver, so that mock must be
    // torn down explicitly or it silently leaks in here.
    jest.dontMock("@/lib/workspaces/workspaceResolver");
    jest.doMock("@/lib/env", () => ({ WORKSPACES_ENABLED: enabled }));
    jest.doMock("@/lib/firestore/workspaces", () => ({
      getWorkspace: jest.fn(async (id: string) => {
        if (!workspaceDocs.has(id)) return { status: "not_found" };
        return { status: "found", workspace: workspaceDocs.get(id) };
      }),
    }));
    const mod = await import("@/lib/workspaces/runWorkspaceIntegrity");
    return mod.validateRunWorkspaceAssociation;
  }

  it("a genuinely valid bound run resolves valid end-to-end", async () => {
    const validate = await loadWithFlag(true);
    const expectedWorkspaceId = `personal-${OWNER_UID}`;
    seedWorkspace(expectedWorkspaceId);
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "valid", workspaceId: expectedWorkspaceId });
  });

  it("W=false + bound run -> invalid/workspaces_disabled end-to-end, no legacy fallback", async () => {
    const validate = await loadWithFlag(false);
    const expectedWorkspaceId = `personal-${OWNER_UID}`;
    seedWorkspace(expectedWorkspaceId);
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspaces_disabled" });
  });

  it("W=false + legacy run (property truly absent on runData) -> legacy unaffected, zero Firestore read", async () => {
    const validate = await loadWithFlag(false);
    const { getWorkspace } = await import("@/lib/firestore/workspaces");
    const result = await validate(OWNER_UID, { question: "x" });
    expect(result).toEqual({ classification: "legacy" });
    expect(getWorkspace).not.toHaveBeenCalled();
  });

  it("a Workspace document whose ownerUserId was mutated to another uid -> invalid/workspace_owner_mismatch end-to-end", async () => {
    const validate = await loadWithFlag(true);
    const expectedWorkspaceId = `personal-${OWNER_UID}`;
    seedWorkspace(expectedWorkspaceId, { ownerUserId: "attacker-or-corruption-uid" });
    const result = await validate(OWNER_UID, { workspaceId: expectedWorkspaceId });
    expect(result).toEqual({ classification: "invalid", reason: "workspace_owner_mismatch" });
  });

  it("REGRESSION GUARD: a run doc built by real Firestore-shaped code (spread from a base object without workspaceId) still classifies as legacy — not just a hand-built test object", async () => {
    const validate = await loadWithFlag(true);
    // Simulates exactly how a route builds its data: `snap.data() as Record<string, unknown>`
    // from a document that was written without ever setting workspaceId.
    const baseRunFields = { userId: OWNER_UID, question: "capital of France", status: "complete" };
    const runData: Record<string, unknown> = { ...baseRunFields };
    const result = await validate(OWNER_UID, runData);
    expect(result).toEqual({ classification: "legacy" });
  });
});
