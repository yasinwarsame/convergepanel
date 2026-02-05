// Jest regression tests for consensus classification in Agreement Map.
// Covers strong consensus, contested, and single-model buckets.
import { buildAgreementMap } from "../agreementMap";
import { ModelResult } from "../types";

function makeResult(modelId: string, text: string): ModelResult {
  return {
    modelId: modelId as any,
    status: "ok",
    rawText: text,
    latencyMs: 0,
  };
}

describe("agreementMap classification", () => {
  it("classifies strong consensus when 2+ models support the same claim", () => {
    const results: ModelResult[] = [
      makeResult("chatgpt", "# Key Claims\n- Democracy provides accountability\n"),
      makeResult("claude", "# Key Claims\n- Democracy provides accountability\n"),
    ];
    const clusters = buildAgreementMap(results);
    const consensus = clusters.filter((c) => c.label === "consensus");
    expect(consensus.length).toBeGreaterThan(0);
  });

  it("classifies contested when models conflict on the same topic", () => {
    const results: ModelResult[] = [
      makeResult("chatgpt", "# Key Claims\n- Democracy improves stability\n"),
      makeResult("grok", "# Key Claims\n- Democracy worsens stability\n"),
    ];
    const clusters = buildAgreementMap(results);
    const contested = clusters.filter((c) => c.label === "disagreement");
    expect(contested.length).toBeGreaterThanOrEqual(1);
  });

  it("classifies single-model insights", () => {
    const results: ModelResult[] = [
      makeResult("perplexity", "# Key Claims\n- Hybrid governance blends benefits\n"),
    ];
    const clusters = buildAgreementMap(results);
    const single = clusters.filter((c) => c.label === "single");
    expect(single.length).toBe(1);
  });
});

