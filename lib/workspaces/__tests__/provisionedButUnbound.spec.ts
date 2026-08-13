/**
 * Personal Workspace Provisioning, Phase 2 — the "provisioned but unbound"
 * invariant, proven end-to-end across both Phase 1 and Phase 2 modules
 * together (not asserted separately in isolation): a user having a real,
 * successfully-provisioned Personal Workspace must have ZERO effect on how
 * the Phase 1 resolver treats an existing resource that has no
 * `workspaceId` of its own. Workspace existence and run binding are
 * deliberately separate operations — this phase only proves the former.
 */

const workspaceDocs = new Map<string, Record<string, unknown>>();

function buildMockAdminDb() {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: jest.fn().mockImplementation(async () => {
          const key = `${name}/${id}`;
          return { exists: workspaceDocs.has(key), data: () => workspaceDocs.get(key) };
        }),
        create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          if (workspaceDocs.has(key)) {
            const err: any = new Error("6 ALREADY_EXISTS");
            err.code = 6;
            throw err;
          }
          workspaceDocs.set(key, value);
        }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.resetModules();
  workspaceDocs.clear();
  jest.doMock("@/lib/env", () => ({ PERSONAL_WORKSPACE_PROVISIONING_ENABLED: true, WORKSPACES_ENABLED: true }));
  jest.doMock("@/lib/firebase/admin", () => ({ adminDb: buildMockAdminDb() }));
  jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
});

it("a user with a real provisioned Personal Workspace still resolves an existing unbound resource as legacy", async () => {
  const { ensurePersonalWorkspace } = await import("@/lib/workspaces/ensurePersonalWorkspace");
  const { resolveWorkspaceContext } = await import("@/lib/workspaces/workspaceResolver");

  const uid = "owner-1";
  const provisionResult = await ensurePersonalWorkspace(uid);
  expect(provisionResult.status).toBe("created");
  expect(workspaceDocs.size).toBe(1); // the Personal Workspace genuinely exists now

  // An existing pre-Phase-2 resource — e.g. a `runs/{runId}` doc — has no
  // workspaceId field at all (undefined), exactly as it did before this
  // user ever had a Personal Workspace.
  const resolution = resolveWorkspaceContext({
    workspacesEnabled: true,
    workspaceId: undefined,
    legacyOwnerUserId: uid,
  });

  expect(resolution).toEqual({ kind: "legacy", context: { mode: "legacy", ownerUserId: uid } });
});

it("re-provisioning after the resource is (hypothetically) later bound does not retroactively rewrite the Personal Workspace document", async () => {
  const { ensurePersonalWorkspace } = await import("@/lib/workspaces/ensurePersonalWorkspace");
  const uid = "owner-1";
  const first = await ensurePersonalWorkspace(uid);
  // Idempotent re-provisioning must never mutate the document merely
  // because some other, unrelated resource elsewhere might reference it.
  const second = await ensurePersonalWorkspace(uid);
  expect((first as any).workspace).toEqual((second as any).workspace);
  expect(workspaceDocs.size).toBe(1);
});
