/**
 * createRun() payload tests, covering two phases that both touch the
 * same single initial `.set()` call:
 *   - Phase 3 (Workspace-Aware Writes for New Personal Adaptive Runs):
 *     the `workspaceId` parameter — a single atomic write, never a
 *     patch-after-create, and an absent `workspaceId` is never persisted
 *     as anything other than what the Admin SDK's own
 *     `ignoreUndefinedProperties` setting would do with a literal
 *     `undefined` field.
 *   - Phase 6D.2 (Going-Forward Run/Project Association Writer): the
 *     `projectId` parameter — present ONLY in the same initial `.set()`
 *     call as `workspaceId`, and only ever `null` (never a real Project
 *     id — that's the future Phase 6D.4 assignment API's job).
 */

const mockedSet = jest.fn();
const mockedDoc = jest.fn(() => ({ set: mockedSet }));
const mockedCollection = jest.fn(() => ({ doc: mockedDoc }));

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: (...args: any[]) => mockedCollection(...args) },
}));

import { createRun } from "@/lib/firestore/runs";

beforeEach(() => {
  jest.clearAllMocks();
  mockedSet.mockResolvedValue(undefined);
});

/**
 * Real production Firestore has `ignoreUndefinedProperties: true`
 * configured (lib/firebase/admin.ts) — the Admin SDK itself strips any
 * key whose value is `undefined` before persisting. This mock bypasses
 * the real SDK entirely, so tests that care about the PERSISTED shape
 * (as opposed to the raw JS object literal `createRun()` constructs)
 * must simulate that stripping explicitly.
 */
function asPersisted(rawPayload: Record<string, unknown>): Record<string, unknown> {
  const persisted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawPayload)) {
    if (value !== undefined) persisted[key] = value;
  }
  return persisted;
}

describe("createRun — workspaceId (Phase 3)", () => {
  it("performs exactly one Firestore write for a run created without a workspaceId (legacy) — the raw object literal always includes the key (relying on ignoreUndefinedProperties to omit it), value is undefined", async () => {
    await createRun("run-1", "uid-1", "question", ["chatgpt", "claude"]);
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedCollection).toHaveBeenCalledWith("runs");
    expect(mockedDoc).toHaveBeenCalledWith("run-1");
    const rawPayload = mockedSet.mock.calls[0][0];
    expect(rawPayload.userId).toBe("uid-1");
    expect("workspaceId" in rawPayload).toBe(true);
    expect(rawPayload.workspaceId).toBeUndefined();
  });

  it("performs exactly one Firestore write that includes workspaceId when provided — never a second, later update() call", async () => {
    await createRun("run-2", "uid-1", "question", ["chatgpt", "claude"], "personal-uid-1");
    expect(mockedSet).toHaveBeenCalledTimes(1);
    const rawPayload = mockedSet.mock.calls[0][0];
    expect(rawPayload.workspaceId).toBe("personal-uid-1");
    expect(rawPayload.userId).toBe("uid-1");
  });

  it("the same single write always sets userId to the true owner, matching workspaceId's owner (ownership consistency)", async () => {
    await createRun("run-3", "uid-42", "q", ["chatgpt", "claude"], "personal-uid-42");
    const rawPayload = mockedSet.mock.calls[0][0];
    expect(rawPayload.userId).toBe("uid-42");
    expect(rawPayload.workspaceId).toBe("personal-uid-42");
  });
});

describe("createRun — Project field initialization (Phase 6D.2)", () => {
  it("Personal-bound + write mode enabled: workspaceId present, projectId present and exactly null", async () => {
    await createRun("run-4", "uid-1", "question", ["chatgpt"], "personal-uid-1", null);
    const writtenRun = asPersisted(mockedSet.mock.calls[0][0]);
    expect(Object.prototype.hasOwnProperty.call(writtenRun, "workspaceId")).toBe(true);
    expect(writtenRun.workspaceId).toBe("personal-uid-1");
    expect(Object.prototype.hasOwnProperty.call(writtenRun, "projectId")).toBe(true);
    expect(writtenRun.projectId).toBeNull();
  });

  it("Personal-bound + write mode disabled (or non-canary): workspaceId present, projectId property ABSENT — the expected temporary state during canary rollout", async () => {
    await createRun("run-5", "uid-1", "question", ["chatgpt"], "personal-uid-1");
    const writtenRun = asPersisted(mockedSet.mock.calls[0][0]);
    expect(Object.prototype.hasOwnProperty.call(writtenRun, "workspaceId")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(writtenRun, "projectId")).toBe(false);
  });

  it("Team adaptive / no Workspace binding: neither workspaceId nor projectId present", async () => {
    await createRun("run-6", "uid-1", "question", ["chatgpt"]);
    const writtenRun = asPersisted(mockedSet.mock.calls[0][0]);
    expect(Object.prototype.hasOwnProperty.call(writtenRun, "workspaceId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(writtenRun, "projectId")).toBe(false);
  });

  it("for every well-formed call shape (matching how the single real caller in app/api/run-panel/route.ts actually invokes this function — proven separately by that route's own wiring tests), projectId is never present without workspaceId also being present", async () => {
    const shapes: Array<[string | undefined, null | undefined]> = [
      [undefined, undefined],
      ["personal-uid-1", undefined],
      ["personal-uid-1", null],
    ];
    for (const [workspaceId, projectId] of shapes) {
      mockedSet.mockClear();
      await createRun("run-x", "uid-1", "q", ["chatgpt"], workspaceId, projectId);
      const writtenRun = asPersisted(mockedSet.mock.calls[0][0]);
      const hasProjectId = Object.prototype.hasOwnProperty.call(writtenRun, "projectId");
      const hasWorkspaceId = Object.prototype.hasOwnProperty.call(writtenRun, "workspaceId");
      if (hasProjectId) {
        expect(hasWorkspaceId).toBe(true);
      }
    }
  });

  it("DOCUMENTED TRUST BOUNDARY: createRun() itself does NOT protect against a caller mistakenly passing projectId=null with workspaceId=undefined — this is why the invariant is enforced by the SINGLE caller's control flow instead (see the route wiring test asserting projectIdForRun is only ever assigned inside the same case block as workspaceIdForRun)", async () => {
    await createRun("run-y", "uid-1", "q", ["chatgpt"], undefined, null);
    const writtenRun = asPersisted(mockedSet.mock.calls[0][0]);
    // This documents the actual (trusted-caller) behavior — a real
    // regression here would mean createRun() started silently correcting
    // caller mistakes, which would be surprising given its own doc
    // comment explicitly disclaims this responsibility.
    expect(writtenRun.projectId).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(writtenRun, "workspaceId")).toBe(false);
  });

  it("SAME-WRITE PROOF: projectId initialization happens via exactly one .set() call — no follow-up .update()", async () => {
    await createRun("run-7", "uid-1", "question", ["chatgpt"], "personal-uid-1", null);
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedDoc).toHaveBeenCalledTimes(1);
  });

  it("client cannot influence the written projectId — the function signature only accepts exactly `null` or `undefined`, never an arbitrary string, for this parameter", async () => {
    // @ts-expect-error — a real Project id string must not type-check here; this function can only ever initialize to null.
    const attempt = () => createRun("run-8", "uid-1", "q", ["chatgpt"], "personal-uid-1", "some-real-project-id");
    expect(typeof attempt).toBe("function"); // compile-time rejection is the real assertion (see @ts-expect-error above)
  });
});
