/**
 * Plan Limits Tests
 * 
 * Ensures plan limits are correct and consistent across the codebase.
 * 
 * Run with: npm test -- lib/__tests__/planLimits.test.ts
 */

import { getVideoLimit } from "@/lib/billing/planConfig";
import { PLAN_CONFIGS, getPlanConfig, normalizeMaxModels } from "@/lib/plans";

describe("Plan Limits", () => {
  describe("PLAN_CONFIGS", () => {
    it("should have correct limits for free plan", () => {
      const free = PLAN_CONFIGS.free;
      expect(free.maxRunsPerMonth).toBe(8);
      expect(free.maxModelsPerRun).toBe(2);
      expect(free.videoVerificationsPerMonth).toBe(0);
    });

    it("should have correct limits for lite plan", () => {
      const lite = PLAN_CONFIGS.lite;
      expect(lite.maxRunsPerMonth).toBe(80); // Updated from 100
      expect(lite.maxModelsPerRun).toBe(3);
      expect(lite.videoVerificationsPerMonth).toBe(5);
    });

    it("should have correct limits for full plan", () => {
      const full = PLAN_CONFIGS.full;
      expect(full.maxRunsPerMonth).toBe(150); // Updated from 400
      expect(full.maxModelsPerRun).toBe(5);
      expect(full.videoVerificationsPerMonth).toBe(20);
    });
  });

  describe("getPlanConfig", () => {
    it("should return correct limits for free plan", () => {
      const config = getPlanConfig("free");
      expect(config.maxRunsPerMonth).toBe(8);
      expect(config.maxModelsPerRun).toBe(2);
    });

    it("should return correct limits for lite plan", () => {
      const config = getPlanConfig("lite");
      expect(config.maxRunsPerMonth).toBe(80);
      expect(config.maxModelsPerRun).toBe(3);
    });

    it("should return correct limits for full plan", () => {
      const config = getPlanConfig("full");
      expect(config.maxRunsPerMonth).toBe(150);
      expect(config.maxModelsPerRun).toBe(5);
    });

    it("should fallback to free plan for invalid plan ID", () => {
      const config = getPlanConfig("invalid" as any);
      expect(config.id).toBe("free");
      expect(config.maxRunsPerMonth).toBe(8);
    });
  });

  describe("getVideoLimit", () => {
    it("returns plan video caps", () => {
      expect(getVideoLimit("free")).toBe(0);
      expect(getVideoLimit("lite")).toBe(5);
      expect(getVideoLimit("full")).toBe(20);
      expect(getVideoLimit("unknown")).toBe(0);
    });
  });

  describe("normalizeMaxModels", () => {
    it("should normalize legacy 4-model plan to 5", () => {
      expect(normalizeMaxModels(4)).toBe(5);
    });

    it("should keep valid values unchanged", () => {
      expect(normalizeMaxModels(2)).toBe(2);
      expect(normalizeMaxModels(3)).toBe(3);
      expect(normalizeMaxModels(5)).toBe(5);
    });

    it("should default invalid values to 2", () => {
      expect(normalizeMaxModels(1)).toBe(2);
      expect(normalizeMaxModels(6)).toBe(2);
      expect(normalizeMaxModels(0)).toBe(2);
      expect(normalizeMaxModels(-1)).toBe(2);
    });
  });

  describe("No hardcoded 400 values", () => {
    it("should not have 400 in plan limits", () => {
      // This test ensures we never accidentally re-introduce 400 as a limit
      const allLimits = Object.values(PLAN_CONFIGS).map((c) => c.maxRunsPerMonth);
      expect(allLimits).not.toContain(400);
      expect(allLimits).toContain(150); // Full plan should be 150
    });
  });
});

