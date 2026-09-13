/**
 * ADD-TO-TEAM-PROJECT §I — deterministic lock id + lock validation.
 * M17 target: an ambiguous `a|b|c` concatenation would make the collision
 * test below pass two DIFFERENT tuples to the same id.
 */

import { Timestamp } from "firebase-admin/firestore";
import { canonicalRunSnapshotLockEncoding, computeRunSnapshotLockId, validateRunSnapshotLock, RUN_SNAPSHOT_LOCK_VERSION } from "../runSnapshotLock";

const tuple = { sourceRunId: "run-a", workspaceId: "ws-1", projectId: "proj-1" };

describe("computeRunSnapshotLockId", () => {
  it("is deterministic and 68 chars (rsl_ + sha256 hex)", () => {
    const a = computeRunSnapshotLockId(tuple);
    const b = computeRunSnapshotLockId({ ...tuple });
    expect(a).toBe(b);
    expect(a).toMatch(/^rsl_[0-9a-f]{64}$/);
  });

  it("changes when ANY tuple member changes", () => {
    const base = computeRunSnapshotLockId(tuple);
    expect(computeRunSnapshotLockId({ ...tuple, sourceRunId: "run-b" })).not.toBe(base);
    expect(computeRunSnapshotLockId({ ...tuple, workspaceId: "ws-2" })).not.toBe(base);
    expect(computeRunSnapshotLockId({ ...tuple, projectId: "proj-2" })).not.toBe(base);
  });

  it("M17 — the encoding is a canonical JSON tuple, so ids containing a would-be separator can never alias a different tuple", () => {
    // Under naive `a|b|c` hashing these two tuples serialize identically.
    const x = { sourceRunId: "run-a|ws-1", workspaceId: "proj-1", projectId: "z" };
    const y = { sourceRunId: "run-a", workspaceId: "ws-1|proj-1", projectId: "z" };
    expect(`${x.sourceRunId}|${x.workspaceId}|${x.projectId}`).toBe(`${y.sourceRunId}|${y.workspaceId}|${y.projectId}`);
    expect(computeRunSnapshotLockId(x)).not.toBe(computeRunSnapshotLockId(y));
    expect(canonicalRunSnapshotLockEncoding(tuple)).toBe('{"version":1,"sourceRunId":"run-a","workspaceId":"ws-1","projectId":"proj-1"}');
    expect(JSON.parse(canonicalRunSnapshotLockEncoding(x))).toEqual({ version: RUN_SNAPSHOT_LOCK_VERSION, ...x });
  });

  it("refuses an empty tuple member rather than hashing a degenerate key", () => {
    expect(() => computeRunSnapshotLockId({ ...tuple, projectId: "" })).toThrow();
  });
});

describe("validateRunSnapshotLock", () => {
  const good = { version: 1, ...tuple, snapshotRunId: "run-snap", createdBy: "uid-1", createdAt: new Timestamp(1, 0) };

  it("accepts a well-formed lock whose tuple matches", () => {
    const r = validateRunSnapshotLock(good, tuple);
    expect(r).toEqual({ ok: true, lock: good });
  });

  it("rejects malformed shapes (missing/empty fields, wrong version, non-Timestamp createdAt, non-object)", () => {
    for (const bad of [
      null,
      [],
      { ...good, version: 2 },
      { ...good, snapshotRunId: "" },
      { ...good, createdBy: undefined },
      { ...good, createdAt: "2026-01-01" },
      { ...good, sourceRunId: 5 },
    ]) {
      expect(validateRunSnapshotLock(bad, tuple)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects a well-formed lock whose stored tuple disagrees with the request (never a hit)", () => {
    expect(validateRunSnapshotLock({ ...good, projectId: "proj-2" }, tuple)).toEqual({ ok: false, reason: "tuple_mismatch" });
    expect(validateRunSnapshotLock({ ...good, sourceRunId: "run-b" }, tuple)).toEqual({ ok: false, reason: "tuple_mismatch" });
    expect(validateRunSnapshotLock({ ...good, workspaceId: "ws-9" }, tuple)).toEqual({ ok: false, reason: "tuple_mismatch" });
  });
});
