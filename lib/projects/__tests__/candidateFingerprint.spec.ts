/**
 * Phase 6D.3A — computeCandidateFingerprint() tests.
 */

import { computeCandidateFingerprint } from "@/lib/projects/candidateFingerprint";
import { createHash } from "crypto";

describe("computeCandidateFingerprint", () => {
  it("empty array -> count 0, hash of empty string", () => {
    const result = computeCandidateFingerprint([]);
    expect(result.candidateCount).toBe(0);
    expect(result.candidateIdSha256).toBe(createHash("sha256").update("", "utf8").digest("hex"));
  });

  it("single id", () => {
    const result = computeCandidateFingerprint(["run-a"]);
    expect(result.candidateCount).toBe(1);
    expect(result.candidateIdSha256).toBe(createHash("sha256").update("run-a", "utf8").digest("hex"));
  });

  it("DETERMINISM: input order never affects the result — sorted internally", () => {
    const a = computeCandidateFingerprint(["run-c", "run-a", "run-b"]);
    const b = computeCandidateFingerprint(["run-a", "run-b", "run-c"]);
    const c = computeCandidateFingerprint(["run-b", "run-c", "run-a"]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("exact encoding: sorted, newline-joined, sha256 hex", () => {
    const result = computeCandidateFingerprint(["run-z", "run-a", "run-m"]);
    const expectedJoined = ["run-a", "run-m", "run-z"].join("\n");
    expect(result.candidateIdSha256).toBe(createHash("sha256").update(expectedJoined, "utf8").digest("hex"));
  });

  it("SECURITY: distinct candidate sets never collide (different count -> different hash, in this test corpus)", () => {
    const a = computeCandidateFingerprint(["run-1", "run-2", "run-3"]);
    const b = computeCandidateFingerprint(["run-1", "run-2", "run-4"]); // one id swapped, same count
    expect(a.candidateCount).toBe(b.candidateCount);
    expect(a.candidateIdSha256).not.toBe(b.candidateIdSha256);
  });

  it("does not mutate the input array", () => {
    const input = ["run-c", "run-a", "run-b"];
    const original = [...input];
    computeCandidateFingerprint(input);
    expect(input).toEqual(original);
  });

  it("duplicate ids in input are preserved as-is (caller's responsibility to dedupe if needed — this function does not silently drop them, which would hide a real correctness bug upstream)", () => {
    const result = computeCandidateFingerprint(["run-a", "run-a", "run-b"]);
    expect(result.candidateCount).toBe(3);
  });
});
