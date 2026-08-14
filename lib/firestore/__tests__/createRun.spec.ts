/**
 * Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3 —
 * createRun()'s workspaceId parameter: confirms a single atomic write
 * (never a patch-after-create), and that an absent workspaceId is never
 * persisted as a literal `undefined` field.
 */

const setCalls: { id: string; data: Record<string, unknown> }[] = [];

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        set: jest.fn().mockImplementation(async (data: Record<string, unknown>) => {
          setCalls.push({ id: `${name}/${id}`, data });
        }),
      }),
    }),
  },
}));

import { createRun } from "@/lib/firestore/runs";

describe("createRun — workspaceId", () => {
  beforeEach(() => {
    setCalls.length = 0;
  });

  it("performs exactly one Firestore write for a run created without a workspaceId (legacy)", async () => {
    await createRun("run-1", "uid-1", "question", ["chatgpt", "claude"]);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].id).toBe("runs/run-1");
    expect(setCalls[0].data.userId).toBe("uid-1");
    expect("workspaceId" in setCalls[0].data).toBe(true);
    expect(setCalls[0].data.workspaceId).toBeUndefined();
  });

  it("performs exactly one Firestore write that includes workspaceId when provided — never a second, later update() call", async () => {
    await createRun("run-2", "uid-1", "question", ["chatgpt", "claude"], "personal-uid-1");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].data.workspaceId).toBe("personal-uid-1");
    expect(setCalls[0].data.userId).toBe("uid-1");
  });

  it("the same single write always sets userId to the true owner, matching workspaceId's owner (ownership consistency)", async () => {
    await createRun("run-3", "uid-42", "q", ["chatgpt", "claude"], "personal-uid-42");
    expect(setCalls[0].data.userId).toBe("uid-42");
    expect(setCalls[0].data.workspaceId).toBe("personal-uid-42");
  });
});
