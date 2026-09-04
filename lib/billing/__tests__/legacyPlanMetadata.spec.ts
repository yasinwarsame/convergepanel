/**
 * Phase BILLING-ANNUAL-MIG-B1 — the validated legacy `targetPlan` reader.
 * The whole security value of the legacy fallback is that it accepts ONLY
 * the exact server-written enum values, so these cases are the contract.
 */

import { readLegacyPlanMetadata } from "../legacyPlanMetadata";

type MetadataOnly = Parameters<typeof readLegacyPlanMetadata>[0];
const sub = (metadata: Record<string, string> | null | undefined): MetadataOnly => ({ metadata: metadata as never });

describe("readLegacyPlanMetadata", () => {
  it("accepts the exact server-written 'full' marker", () => {
    expect(readLegacyPlanMetadata(sub({ targetPlan: "full" }))).toBe("full");
  });

  it("accepts the exact server-written 'lite' marker", () => {
    expect(readLegacyPlanMetadata(sub({ targetPlan: "lite" }))).toBe("lite");
  });

  it("fails closed when metadata is absent entirely", () => {
    expect(readLegacyPlanMetadata(sub(null))).toBeNull();
    expect(readLegacyPlanMetadata(sub(undefined))).toBeNull();
  });

  it("fails closed when the marker key is missing", () => {
    expect(readLegacyPlanMetadata(sub({ firebaseUid: "u1" }))).toBeNull();
  });

  it("fails closed on 'free' — metadata may only ever assert a PAID plan", () => {
    expect(readLegacyPlanMetadata(sub({ targetPlan: "free" }))).toBeNull();
  });

  it("fails closed on unknown plan names, never granting an unrecognized tier", () => {
    for (const value of ["enterprise", "pro", "admin", "5_models", "unlimited"]) {
      expect(readLegacyPlanMetadata(sub({ targetPlan: value }))).toBeNull();
    }
  });

  it("fails closed on malformed variants rather than repairing them", () => {
    for (const value of ["FULL", "Full", " full", "full ", "full\n", ""]) {
      expect(readLegacyPlanMetadata(sub({ targetPlan: value }))).toBeNull();
    }
  });

  it("fails closed when the marker is not a string", () => {
    for (const value of [1, true, null, {}, ["full"]]) {
      expect(readLegacyPlanMetadata(sub({ targetPlan: value as never }))).toBeNull();
    }
  });

  it("does not read any other metadata key as a plan grant", () => {
    expect(readLegacyPlanMetadata(sub({ plan: "full", planId: "full", targetplan: "full" }))).toBeNull();
  });
});
