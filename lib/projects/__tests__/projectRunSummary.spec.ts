import { toProjectRunSummary, firestoreSecondsNanos } from "@/lib/projects/projectRunSummary";

describe("toProjectRunSummary", () => {
  it("derives the expected shape from a minimal run document", () => {
    const data = {
      question: "What is the capital of France?",
      selectedModels: ["gpt-4"],
      status: "complete",
      createdAt: { toMillis: () => 1723600000000 },
    };
    const summary = toProjectRunSummary("run-1", data, "proj-1");
    expect(summary).toMatchObject({
      id: "run-1",
      question: "What is the capital of France?",
      selectedModels: ["gpt-4"],
      status: "complete",
      projectId: "proj-1",
    });
    expect(summary.at).toBe(new Date(1723600000000).toISOString());
  });

  it("passes projectId through unchanged, including null", () => {
    const data = { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 } };
    expect(toProjectRunSummary("run-1", data, null).projectId).toBeNull();
    expect(toProjectRunSummary("run-1", data, "proj-9").projectId).toBe("proj-9");
  });

  it("never exposes workspaceId or userId even if present on the raw document", () => {
    const data = { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 }, workspaceId: "personal-x", userId: "x" };
    const summary = toProjectRunSummary("run-1", data, null) as Record<string, unknown>;
    expect(summary.workspaceId).toBeUndefined();
    expect(summary.userId).toBeUndefined();
  });

  it("derives governanceStatus only from a recognized value", () => {
    const base = { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 } };
    expect(toProjectRunSummary("r", { ...base, governanceStatus: "approved" }, null).governanceStatus).toBe("approved");
    expect(toProjectRunSummary("r", { ...base, governanceStatus: "bogus" }, null).governanceStatus).toBeUndefined();
  });

  it("modelsOk/modelsTotal derived from perModel when present", () => {
    const data = {
      question: "q",
      selectedModels: ["a", "b"],
      createdAt: { toMillis: () => 1 },
      resultsCompact: { perModel: [{ status: "ok" }, { status: "error" }] },
    };
    const summary = toProjectRunSummary("r", data, null);
    expect(summary.modelsOk).toBe(1);
    expect(summary.modelsTotal).toBe(2);
  });
});

describe("firestoreSecondsNanos", () => {
  it("extracts seconds/nanoseconds from a Timestamp-shaped value", () => {
    expect(firestoreSecondsNanos({ seconds: 100, nanoseconds: 250 })).toEqual({ seconds: 100, nanoseconds: 250 });
  });

  it("defaults to zero for a non-Timestamp value", () => {
    expect(firestoreSecondsNanos(undefined)).toEqual({ seconds: 0, nanoseconds: 0 });
    expect(firestoreSecondsNanos(null)).toEqual({ seconds: 0, nanoseconds: 0 });
    expect(firestoreSecondsNanos("not a timestamp")).toEqual({ seconds: 0, nanoseconds: 0 });
  });
});
