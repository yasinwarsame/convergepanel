/**
 * Phase 4B — createRunWorkspaceIntegrityBatch() tests. Proves the N+1
 * mitigation claim from a real call-count assertion, not just a design
 * comment: owner-scoped lists collapse to one underlying resolution;
 * reviewer-scoped lists collapse to one per distinct owner, never one per
 * row; and two different owners sharing a corrupted identical workspaceId
 * string are never conflated into one cached result.
 */

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const OWNER_C = "owner-c";

describe("createRunWorkspaceIntegrityBatch", () => {
  function mockUnderlyingValidator() {
    jest.resetModules();
    const calls: Array<{ userId: string; runData: Record<string, unknown> }> = [];
    jest.doMock("@/lib/workspaces/runWorkspaceIntegrity", () => {
      const actual = jest.requireActual("@/lib/workspaces/runWorkspaceIntegrity");
      return {
        ...actual,
        validateRunWorkspaceAssociation: jest.fn(async (userId: string, runData: Record<string, unknown>) => {
          calls.push({ userId, runData });
          if (!Object.prototype.hasOwnProperty.call(runData, "workspaceId")) {
            return { classification: "legacy" };
          }
          return { classification: "valid", workspaceId: `personal-${userId}` };
        }),
      };
    });
    return calls;
  }

  it("owner-scoped list: 50 rows, same owner, same deterministic workspaceId -> exactly one underlying call", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rows = Array.from({ length: 50 }, () => ({ workspaceId: `personal-${OWNER_A}` }));
    const results = await Promise.all(rows.map((r) => validate(OWNER_A, r)));

    expect(calls.length).toBe(1);
    expect(validate.distinctLookupCount).toBe(1);
    results.forEach((r) => expect(r).toEqual({ classification: "valid", workspaceId: `personal-${OWNER_A}` }));
  });

  it("reviewer-scoped list: rows from 3 distinct owners -> exactly 3 underlying calls, never 1 per row", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rows: Array<[string, Record<string, unknown>]> = [
      [OWNER_A, { workspaceId: `personal-${OWNER_A}` }],
      [OWNER_A, { workspaceId: `personal-${OWNER_A}` }], // same owner appears twice
      [OWNER_B, { workspaceId: `personal-${OWNER_B}` }],
      [OWNER_C, { workspaceId: `personal-${OWNER_C}` }],
      [OWNER_C, { workspaceId: `personal-${OWNER_C}` }], // same owner appears twice
    ];
    await Promise.all(rows.map(([uid, r]) => validate(uid, r)));

    expect(calls.length).toBe(3);
    expect(validate.distinctLookupCount).toBe(3);
  });

  it("legacy rows (workspaceId truly absent) are cached and deduped like any other key, never call the resolver twice for the same owner", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rows = [{}, {}, {}];
    const results = await Promise.all(rows.map((r) => validate(OWNER_A, r)));

    expect(calls.length).toBe(1);
    results.forEach((r) => expect(r).toEqual({ classification: "legacy" }));
  });

  it("THREAT: two different owners sharing an identical (corrupted) workspaceId string are validated independently, never conflated", async () => {
    jest.resetModules();
    const calls: Array<{ userId: string; runData: Record<string, unknown> }> = [];
    jest.doMock("@/lib/workspaces/runWorkspaceIntegrity", () => {
      const actual = jest.requireActual("@/lib/workspaces/runWorkspaceIntegrity");
      return {
        ...actual,
        validateRunWorkspaceAssociation: jest.fn(async (userId: string, runData: Record<string, unknown>) => {
          calls.push({ userId, runData });
          // Only OWNER_A's claim is actually correct for this shared id.
          if (userId === OWNER_A && runData.workspaceId === "personal-owner-a") {
            return { classification: "valid", workspaceId: "personal-owner-a" };
          }
          return { classification: "invalid", reason: "deterministic_id_mismatch" };
        }),
      };
    });
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rowA: Record<string, unknown> = { workspaceId: "personal-owner-a" };
    const rowBCorrupted: Record<string, unknown> = { workspaceId: "personal-owner-a" }; // B's row corrupted to point at A's id
    const [resultA, resultB] = await Promise.all([validate(OWNER_A, rowA), validate(OWNER_B, rowBCorrupted)]);

    expect(calls.length).toBe(2); // NOT deduped, despite identical workspaceId string
    expect(resultA).toEqual({ classification: "valid", workspaceId: "personal-owner-a" });
    expect(resultB).toEqual({ classification: "invalid", reason: "deterministic_id_mismatch" });
  });

  it("a fresh batch instance per call site has no cross-request leakage (no shared module-level cache)", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validateRequest1 = createRunWorkspaceIntegrityBatch();
    const validateRequest2 = createRunWorkspaceIntegrityBatch();

    await validateRequest1(OWNER_A, { workspaceId: `personal-${OWNER_A}` });
    await validateRequest2(OWNER_A, { workspaceId: `personal-${OWNER_A}` });

    expect(calls.length).toBe(2); // each batch instance has its own cache
  });

  it("REGRESSION GUARD: a fresh-object row with no workspaceId key at all is legacy, not accidentally invalid (the exact bug this whole redesign fixed)", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    // Simulates a real Firestore doc snapshot's data() for a legacy run.
    const runData: Record<string, unknown> = { userId: OWNER_A, question: "x", status: "complete" };
    const result = await validate(OWNER_A, runData);
    expect(result).toEqual({ classification: "legacy" });
  });
});
