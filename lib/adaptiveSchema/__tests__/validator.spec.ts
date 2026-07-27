/**
 * Adaptive Response Validator Tests
 *
 * Covers: malformed JSON, over-cap arrays, word-cap truncation, and the
 * contract that a model whose response fails parsing gets a parseError
 * result rather than throwing.
 */

import { validateAdaptiveResponse } from "@/lib/adaptiveSchema/validator";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";

describe("validateAdaptiveResponse", () => {
  it("returns a parseError for an empty response", () => {
    const result = validateAdaptiveResponse("chatgpt", SCHEMA_REGISTRY.generic, null);
    expect(result.ok).toBe(false);
    expect(result.parseError).toBeTruthy();
  });

  it("returns a parseError for malformed JSON instead of throwing", () => {
    const result = validateAdaptiveResponse("chatgpt", SCHEMA_REGISTRY.generic, "not json at all {{{");
    expect(result.ok).toBe(false);
    expect(result.parseError).toMatch(/Invalid JSON/);
  });

  it("returns a parseError when required keys are missing", () => {
    const result = validateAdaptiveResponse(
      "chatgpt",
      SCHEMA_REGISTRY.factual_lookup,
      JSON.stringify({ answer: "42" }) // missing source, caveat
    );
    expect(result.ok).toBe(false);
    expect(result.parseError).toMatch(/Schema validation failed/);
  });

  it("strips markdown fences before parsing", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ answer: "42", source: "reference", caveat: "none" }) +
      "\n```";
    const result = validateAdaptiveResponse("chatgpt", SCHEMA_REGISTRY.factual_lookup, raw);
    expect(result.ok).toBe(true);
    expect(result.data?.answer).toBe("42");
  });

  it("soft-truncates a string field over its word cap", () => {
    const longSummary = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const result = validateAdaptiveResponse(
      "chatgpt",
      SCHEMA_REGISTRY.generic, // summary maxWords: 80
      JSON.stringify({ summary: longSummary, keyClaims: [], uncertainties: [], followUps: [] })
    );

    expect(result.ok).toBe(true);
    expect(result.truncatedFields).toContain("summary");
    expect((result.data?.summary as string).split(/\s+/).length).toBe(80); // capped at 80 words (ellipsis joins the last word)
    expect((result.data?.summary as string).endsWith("…")).toBe(true);
  });

  it("truncates an array field over its item cap", () => {
    const result = validateAdaptiveResponse(
      "chatgpt",
      SCHEMA_REGISTRY.generic, // uncertainties maxItems: 3
      JSON.stringify({
        summary: "ok",
        keyClaims: [],
        uncertainties: ["a", "b", "c", "d", "e"],
        followUps: [],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.data?.uncertainties).toEqual(["a", "b", "c"]);
    expect(result.truncatedFields).toContain("uncertainties");
  });

  it("does not flag truncation when a response is within all caps", () => {
    const result = validateAdaptiveResponse(
      "chatgpt",
      SCHEMA_REGISTRY.generic,
      JSON.stringify({
        summary: "a short summary",
        keyClaims: [],
        uncertainties: ["only one"],
        followUps: [],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.truncatedFields).toBeUndefined();
  });

  it("truncates a nested claim's text over its intrinsic 25-word cap", () => {
    const longClaim = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const result = validateAdaptiveResponse(
      "chatgpt",
      SCHEMA_REGISTRY.generic,
      JSON.stringify({
        summary: "ok",
        keyClaims: [
          {
            id: "some-claim",
            claim: longClaim,
            stance: "asserts",
            confidence: "settled",
            evidenceType: "empirical",
          },
        ],
        uncertainties: [],
        followUps: [],
      })
    );

    expect(result.ok).toBe(true);
    const claims = result.data?.keyClaims as any[];
    expect(claims[0].claim.split(/\s+/).length).toBe(25); // capped at 25 words (ellipsis joins the last word)
    expect(claims[0].claim.endsWith("…")).toBe(true);
    expect(result.truncatedFields).toContain("keyClaims");
  });

  it("rejects a response that is a JSON array instead of an object", () => {
    const result = validateAdaptiveResponse("chatgpt", SCHEMA_REGISTRY.generic, JSON.stringify(["not", "an", "object"]));
    expect(result.ok).toBe(false);
    expect(result.parseError).toMatch(/not a JSON object/);
  });
});
