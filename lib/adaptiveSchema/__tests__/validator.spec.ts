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

  it("salvages the fields present and marks missing required keys as invalidFields, instead of discarding the whole response", () => {
    const result = validateAdaptiveResponse(
      "chatgpt",
      SCHEMA_REGISTRY.factual_lookup,
      JSON.stringify({ answer: "42" }) // missing source, caveat
    );
    expect(result.ok).toBe(true);
    expect(result.data?.answer).toBe("42");
    expect(result.invalidFields).toEqual(expect.arrayContaining(["source", "caveat"]));
  });

  it("returns a parseError when nothing at all survives validation", () => {
    const result = validateAdaptiveResponse(
      "chatgpt",
      SCHEMA_REGISTRY.factual_lookup,
      JSON.stringify({ unrelatedKey: 123 })
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

  describe("enum coercion + field-level salvage (Gemini stance-drift regression)", () => {
    // Reproduces the reported bug: Gemini 2.0 Flash returning "Agrees"/
    // "disagrees" instead of the exact "asserts"/"disputes"/"uncertain"
    // vocabulary for Claim.stance.
    const GEMINI_STANCE_DRIFT_FIXTURE = JSON.stringify({
      summary: "Experts disagree on whether remote work reduces productivity.",
      settledClaims: [],
      disputedClaims: [
        {
          id: "remote-work-productivity-gain",
          claim: "Remote work increases individual productivity for focused tasks.",
          stance: "Agrees",
          confidence: "majority_view",
          evidenceType: "empirical",
        },
        {
          id: "remote-work-collab-cost",
          claim: "Remote work reduces spontaneous collaboration and mentorship.",
          stance: "disagrees",
          confidence: "contested",
          evidenceType: "anecdotal",
        },
        {
          id: "remote-work-net-effect",
          claim: "The net effect on productivity depends heavily on role and industry.",
          stance: "unclear",
          confidence: "speculative",
          evidenceType: "theoretical",
        },
      ],
      keyMetrics: [],
      openQuestions: [],
    });

    it("coerces 'Agrees'/'disagrees'/'unclear' cleanly — full response validates, no salvage needed", () => {
      const result = validateAdaptiveResponse("gemini", SCHEMA_REGISTRY.contested_empirical, GEMINI_STANCE_DRIFT_FIXTURE);

      expect(result.ok).toBe(true);
      expect(result.invalidFields).toBeUndefined();
      const claims = result.data?.disputedClaims as any[];
      expect(claims).toHaveLength(3);
      expect(claims.map((c) => c.stance)).toEqual(["asserts", "disputes", "uncertain"]);

      expect(result.coercions).toBeDefined();
      expect(result.coercions).toHaveLength(3);
      expect(result.coercions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "stance", raw: "Agrees", coerced: "asserts" }),
          expect.objectContaining({ field: "stance", raw: "disagrees", coerced: "disputes" }),
          expect.objectContaining({ field: "stance", raw: "unclear", coerced: "uncertain" }),
        ])
      );
    });

    it("salvages 3 valid claims out of 4 when one claim has an unrecoverable stance value", () => {
      const raw = JSON.stringify({
        summary: "Experts disagree on whether remote work reduces productivity.",
        settledClaims: [],
        disputedClaims: [
          {
            id: "remote-work-productivity-gain",
            claim: "Remote work increases individual productivity for focused tasks.",
            stance: "asserts",
            confidence: "majority_view",
            evidenceType: "empirical",
          },
          {
            id: "remote-work-collab-cost",
            claim: "Remote work reduces spontaneous collaboration and mentorship.",
            stance: "disputes",
            confidence: "contested",
            evidenceType: "anecdotal",
          },
          {
            id: "remote-work-net-effect",
            claim: "The net effect on productivity depends heavily on role and industry.",
            stance: "uncertain",
            confidence: "speculative",
            evidenceType: "theoretical",
          },
          {
            // Genuinely unrecoverable — not a known synonym or formatting variant.
            id: "remote-work-broken",
            claim: "Remote work always increases output regardless of role.",
            stance: "definitely-yes",
            confidence: "settled",
            evidenceType: "empirical",
          },
        ],
        keyMetrics: [],
        openQuestions: [],
      });

      const result = validateAdaptiveResponse("gemini", SCHEMA_REGISTRY.contested_empirical, raw);

      expect(result.ok).toBe(true);
      const claims = result.data?.disputedClaims as any[];
      expect(claims).toHaveLength(3); // the broken 4th claim is dropped, not the whole response
      expect(claims.map((c) => c.id)).not.toContain("remote-work-broken");
      // The field itself salvaged successfully (3/4 items kept), so it's not
      // reported as an invalid/absent field — only a field with ZERO
      // recoverable items would be.
      expect(result.invalidFields).toBeUndefined();
    });

    it("marks a scalar field invalid/absent (not the whole response) when it fails validation alongside valid array fields", () => {
      const raw = JSON.stringify({
        summary: 12345, // wrong type — should be a string
        settledClaims: [],
        disputedClaims: [
          {
            id: "remote-work-productivity-gain",
            claim: "Remote work increases individual productivity for focused tasks.",
            stance: "asserts",
            confidence: "majority_view",
            evidenceType: "empirical",
          },
        ],
        keyMetrics: [],
        openQuestions: [],
      });

      const result = validateAdaptiveResponse("gemini", SCHEMA_REGISTRY.contested_empirical, raw);

      expect(result.ok).toBe(true);
      expect(result.invalidFields).toEqual(["summary"]);
      expect(result.data?.disputedClaims).toHaveLength(1);
    });

    it("returns ok:false only when literally nothing survives coercion + salvage", () => {
      const raw = JSON.stringify({
        summary: 12345,
        settledClaims: [{ bad: "shape" }],
        disputedClaims: [{ stance: "definitely-yes" }],
        keyMetrics: "not-an-array",
        openQuestions: [42, 43],
      });

      const result = validateAdaptiveResponse("gemini", SCHEMA_REGISTRY.contested_empirical, raw);

      expect(result.ok).toBe(false);
      expect(result.data).toBeNull();
      expect(result.parseError).toMatch(/Schema validation failed/);
    });
  });
});
