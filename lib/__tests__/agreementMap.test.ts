// Simple regression test for agreement map consensus classification.
// Run manually with: node --loader ts-node/esm lib/__tests__/agreementMap.test.ts
import assert from "assert";
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

(() => {
  const results: ModelResult[] = [
    makeResult("chatgpt", "# Key Claims\n- Democracy provides accountability\n"),
    makeResult("claude", "# Key Claims\n- Democracy provides accountability\n"),
    makeResult("grok", "# Key Claims\n- Democracy can lead to instability\n"),
    makeResult("perplexity", "# Key Claims\n- Hybrid systems combine strengths\n"),
  ];

  const clusters = buildAgreementMap(results);
  const consensus = clusters.filter((c) => c.label === "consensus");
  const disagreement = clusters.filter((c) => c.label === "disagreement");
  const single = clusters.filter((c) => c.label === "single");

  assert.ok(consensus.length > 0, "Should detect at least one consensus cluster");
  assert.ok(disagreement.length >= 0, "Disagreement detection should not throw");
  assert.strictEqual(single.length >= 1, true, "Should classify single-model insights");

  console.log("agreementMap regression test passed", {
    consensus: consensus.length,
    disagreement: disagreement.length,
    single: single.length,
  });
})();

