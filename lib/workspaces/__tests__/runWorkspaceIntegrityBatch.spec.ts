/**
 * Phase 4B — createRunWorkspaceIntegrityBatch() tests. Proves the N+1
 * mitigation claim from a real call-count assertion, not just a design
 * comment: owner-scoped lists collapse to one underlying resolution;
 * reviewer-scoped lists collapse to one per distinct owner, never one per
 * row; and two different owners sharing a corrupted identical workspaceId
 * string are never conflated into one cached result. Also proves the
 * batch validator's own signature is single-argument, matching the
 * underlying primitive's no-caller-supplied-identity design.
 */

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const OWNER_C = "owner-c";

describe("createRunWorkspaceIntegrityBatch", () => {
  function mockUnderlyingValidator() {
    jest.resetModules();
    const calls: Array<Record<string, unknown>> = [];
    jest.doMock("@/lib/workspaces/runWorkspaceIntegrity", () => {
      const actual = jest.requireActual("@/lib/workspaces/runWorkspaceIntegrity");
      return {
        ...actual,
        validateRunWorkspaceAssociation: jest.fn(async (runData: Record<string, unknown>) => {
          calls.push(runData);
          if (!Object.prototype.hasOwnProperty.call(runData, "workspaceId")) {
            return { classification: "legacy" };
          }
          return { classification: "valid", workspaceId: `personal-${runData.userId}` };
        }),
      };
    });
    return calls;
  }

  it("the batch validator takes exactly one parameter — runData, nothing else", async () => {
    mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();
    expect(validate.length).toBe(1);
  });

  it("owner-scoped list: 50 rows, same owner, same deterministic workspaceId -> exactly one underlying call", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rows = Array.from({ length: 50 }, () => ({ userId: OWNER_A, workspaceId: `personal-${OWNER_A}` }));
    const results = await Promise.all(rows.map((r) => validate(r)));

    expect(calls.length).toBe(1);
    expect(validate.distinctLookupCount).toBe(1);
    results.forEach((r) => expect(r).toEqual({ classification: "valid", workspaceId: `personal-${OWNER_A}` }));
  });

  it("reviewer-scoped list: rows from 3 distinct owners -> exactly 3 underlying calls, never 1 per row", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rows: Record<string, unknown>[] = [
      { userId: OWNER_A, workspaceId: `personal-${OWNER_A}` },
      { userId: OWNER_A, workspaceId: `personal-${OWNER_A}` }, // same owner appears twice
      { userId: OWNER_B, workspaceId: `personal-${OWNER_B}` },
      { userId: OWNER_C, workspaceId: `personal-${OWNER_C}` },
      { userId: OWNER_C, workspaceId: `personal-${OWNER_C}` }, // same owner appears twice
    ];
    await Promise.all(rows.map((r) => validate(r)));

    expect(calls.length).toBe(3);
    expect(validate.distinctLookupCount).toBe(3);
  });

  it("legacy rows (workspaceId truly absent) are cached and deduped like any other key, never call the resolver twice for the same owner", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rows = [{ userId: OWNER_A }, { userId: OWNER_A }, { userId: OWNER_A }];
    const results = await Promise.all(rows.map((r) => validate(r)));

    expect(calls.length).toBe(1);
    results.forEach((r) => expect(r).toEqual({ classification: "legacy" }));
  });

  it("THREAT: two different owners sharing an identical (corrupted) workspaceId string are validated independently, never conflated", async () => {
    jest.resetModules();
    const calls: Array<Record<string, unknown>> = [];
    jest.doMock("@/lib/workspaces/runWorkspaceIntegrity", () => {
      const actual = jest.requireActual("@/lib/workspaces/runWorkspaceIntegrity");
      return {
        ...actual,
        validateRunWorkspaceAssociation: jest.fn(async (runData: Record<string, unknown>) => {
          calls.push(runData);
          // Only OWNER_A's claim is actually correct for this shared id.
          if (runData.userId === OWNER_A && runData.workspaceId === "personal-owner-a") {
            return { classification: "valid", workspaceId: "personal-owner-a" };
          }
          return { classification: "invalid", reason: "deterministic_id_mismatch" };
        }),
      };
    });
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    const rowA: Record<string, unknown> = { userId: OWNER_A, workspaceId: "personal-owner-a" };
    const rowBCorrupted: Record<string, unknown> = { userId: OWNER_B, workspaceId: "personal-owner-a" }; // B's row corrupted to point at A's id
    const [resultA, resultB] = await Promise.all([validate(rowA), validate(rowBCorrupted)]);

    expect(calls.length).toBe(2); // NOT deduped, despite identical workspaceId string
    expect(resultA).toEqual({ classification: "valid", workspaceId: "personal-owner-a" });
    expect(resultB).toEqual({ classification: "invalid", reason: "deterministic_id_mismatch" });
  });

  it("a fresh batch instance per call site has no cross-request leakage (no shared module-level cache)", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validateRequest1 = createRunWorkspaceIntegrityBatch();
    const validateRequest2 = createRunWorkspaceIntegrityBatch();

    await validateRequest1({ userId: OWNER_A, workspaceId: `personal-${OWNER_A}` });
    await validateRequest2({ userId: OWNER_A, workspaceId: `personal-${OWNER_A}` });

    expect(calls.length).toBe(2); // each batch instance has its own cache
  });

  it("REGRESSION GUARD: a fresh-object row with no workspaceId key at all is legacy, not accidentally invalid (the exact bug an earlier redesign fixed)", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    // Simulates a real Firestore doc snapshot's data() for a legacy run.
    const runData: Record<string, unknown> = { userId: OWNER_A, question: "x", status: "complete" };
    const result = await validate(runData);
    expect(result).toEqual({ classification: "legacy" });
  });

  it("THREAT: two rows with DIFFERENT userId but the SAME (corrupted, mismatched) workspaceId never share a cache key even if a naive implementation keyed on workspaceId alone", async () => {
    const calls = mockUnderlyingValidator();
    const { createRunWorkspaceIntegrityBatch } = await import("@/lib/workspaces/runWorkspaceIntegrityBatch");
    const validate = createRunWorkspaceIntegrityBatch();

    await Promise.all([
      validate({ userId: OWNER_A, workspaceId: "personal-owner-a" }),
      validate({ userId: OWNER_B, workspaceId: "personal-owner-a" }),
    ]);
    expect(validate.distinctLookupCount).toBe(2);
    expect(calls.length).toBe(2);
  });
});
