/**
 * ADD-TO-TEAM-PROJECT §L — provenance builder + structural check.
 */

import { Timestamp } from "firebase-admin/firestore";
import { buildPersonalResearchSnapshotOrigin, isWellFormedPersonalResearchSnapshotOrigin } from "../personalResearchSnapshotOrigin";

const created = new Timestamp(500, 0);
const completed = new Timestamp(600, 0);

describe("buildPersonalResearchSnapshotOrigin", () => {
  it("records type, source pointer and the source's own timestamps — nothing else", () => {
    const o = buildPersonalResearchSnapshotOrigin({ sourceRunId: "run-a", sourceCreatedAt: created, sourceCompletedAt: completed });
    expect(o).toEqual({ type: "personal_research", runId: "run-a", sourceCreatedAt: created, sourceCompletedAt: completed });
    expect(Object.keys(o!)).toEqual(["type", "runId", "sourceCreatedAt", "sourceCompletedAt"]);
  });

  it("completedAt absent or not a Timestamp → null (never fabricated)", () => {
    expect(buildPersonalResearchSnapshotOrigin({ sourceRunId: "run-a", sourceCreatedAt: created, sourceCompletedAt: undefined })!.sourceCompletedAt).toBeNull();
    expect(buildPersonalResearchSnapshotOrigin({ sourceRunId: "run-a", sourceCreatedAt: created, sourceCompletedAt: "2026" })!.sourceCompletedAt).toBeNull();
  });

  it("createdAt not a Timestamp, or a blank source id → null", () => {
    expect(buildPersonalResearchSnapshotOrigin({ sourceRunId: "run-a", sourceCreatedAt: new Date(), sourceCompletedAt: completed })).toBeNull();
    expect(buildPersonalResearchSnapshotOrigin({ sourceRunId: "", sourceCreatedAt: created, sourceCompletedAt: completed })).toBeNull();
  });
});

describe("isWellFormedPersonalResearchSnapshotOrigin", () => {
  const good = { type: "personal_research", runId: "run-a", sourceCreatedAt: created, sourceCompletedAt: null };

  it("accepts a well-formed origin for the EXPECTED source only", () => {
    expect(isWellFormedPersonalResearchSnapshotOrigin(good, "run-a")).toBe(true);
    expect(isWellFormedPersonalResearchSnapshotOrigin(good, "run-b")).toBe(false);
  });

  it("rejects wrong type, missing pointer, non-Timestamp dates, non-objects", () => {
    expect(isWellFormedPersonalResearchSnapshotOrigin({ ...good, type: "deep_research_claim" }, "run-a")).toBe(false);
    expect(isWellFormedPersonalResearchSnapshotOrigin({ ...good, runId: "" }, "run-a")).toBe(false);
    expect(isWellFormedPersonalResearchSnapshotOrigin({ ...good, sourceCreatedAt: "x" }, "run-a")).toBe(false);
    expect(isWellFormedPersonalResearchSnapshotOrigin({ ...good, sourceCompletedAt: "x" }, "run-a")).toBe(false);
    expect(isWellFormedPersonalResearchSnapshotOrigin(null, "run-a")).toBe(false);
    expect(isWellFormedPersonalResearchSnapshotOrigin(undefined, "run-a")).toBe(false);
  });
});
