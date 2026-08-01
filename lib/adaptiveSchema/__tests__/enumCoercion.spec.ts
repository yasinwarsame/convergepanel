/**
 * Enum Coercion Tests
 *
 * Covers: case-insensitive stance synonym recovery, format-only
 * normalization for confidence/evidenceType, and the guardrail that
 * confidence never gets a semantic reinterpretation (e.g. "high" must NOT
 * become "settled").
 */

import { coerceClaimEnums } from "@/lib/adaptiveSchema/enumCoercion";

const ctx = { modelId: "gemini" as const, schemaId: "contested_empirical" as const, path: "disputedClaims[0]" };

describe("coerceClaimEnums", () => {
  it("coerces known stance synonyms case-insensitively", () => {
    const { claim, log } = coerceClaimEnums(
      { id: "a", claim: "x", stance: "Agrees", confidence: "settled", evidenceType: "empirical" },
      ctx
    );
    expect(claim.stance).toBe("asserts");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ field: "stance", raw: "Agrees", coerced: "asserts", path: "disputedClaims[0].stance" });
  });

  it("coerces 'disagrees' to 'disputes'", () => {
    const { claim } = coerceClaimEnums(
      { id: "a", claim: "x", stance: "disagrees", confidence: "settled", evidenceType: "empirical" },
      ctx
    );
    expect(claim.stance).toBe("disputes");
  });

  it("coerces 'unclear'/'mixed'/'unsure' to 'uncertain'", () => {
    for (const raw of ["unclear", "MIXED", "unsure"]) {
      const { claim } = coerceClaimEnums({ id: "a", claim: "x", stance: raw, confidence: "settled", evidenceType: "empirical" }, ctx);
      expect(claim.stance).toBe("uncertain");
    }
  });

  it("leaves an already-valid stance untouched with no log entry", () => {
    const { claim, log } = coerceClaimEnums(
      { id: "a", claim: "x", stance: "asserts", confidence: "settled", evidenceType: "empirical" },
      ctx
    );
    expect(claim.stance).toBe("asserts");
    expect(log).toHaveLength(0);
  });

  it("normalizes confidence formatting drift (casing/spacing) without reinterpreting meaning", () => {
    const { claim, log } = coerceClaimEnums(
      { id: "a", claim: "x", stance: "asserts", confidence: "Majority View", evidenceType: "empirical" },
      ctx
    );
    expect(claim.confidence).toBe("majority_view");
    expect(log.some((l) => l.field === "confidence")).toBe(true);
  });

  it("never coerces a semantic confidence value like 'high' to 'settled'", () => {
    const { claim, log } = coerceClaimEnums(
      { id: "a", claim: "x", stance: "asserts", confidence: "high", evidenceType: "empirical" },
      ctx
    );
    expect(claim.confidence).toBe("high"); // left invalid — Zod will reject it, not guessed
    expect(log.some((l) => l.field === "confidence")).toBe(false);
  });

  it("normalizes evidenceType formatting drift", () => {
    const { claim } = coerceClaimEnums(
      { id: "a", claim: "x", stance: "asserts", confidence: "settled", evidenceType: "Empirical" },
      ctx
    );
    expect(claim.evidenceType).toBe("empirical");
  });

  it("leaves a genuinely unknown value untouched for Zod to reject", () => {
    const { claim, log } = coerceClaimEnums(
      { id: "a", claim: "x", stance: "somewhat-agrees-ish", confidence: "settled", evidenceType: "empirical" },
      ctx
    );
    expect(claim.stance).toBe("somewhat-agrees-ish");
    expect(log).toHaveLength(0);
  });

  it("does not mutate the input object", () => {
    const original = { id: "a", claim: "x", stance: "Agrees", confidence: "settled", evidenceType: "empirical" };
    const snapshot = { ...original };
    coerceClaimEnums(original, ctx);
    expect(original).toEqual(snapshot);
  });
});
