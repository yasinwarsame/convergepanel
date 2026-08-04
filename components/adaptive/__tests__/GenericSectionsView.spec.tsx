/**
 * B6 regression test: Uncertainties/Follow-ups previously deduped only by
 * exact string match, so near-duplicate paraphrases across models rendered
 * as separate bullets. Renders the real component (react-dom/server, no
 * jsdom needed) and asserts a paraphrased pair collapses to one bullet.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GenericSectionsView from "@/components/adaptive/GenericSectionsView";
import { AdaptiveModelResult, QueryClassification } from "@/lib/adaptiveSchema/types";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";

const classification: QueryClassification = {
  queryType: "generic",
  domain: "test",
  answerShape: "generic_sections",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "get_answer",
  confidence: 0.9,
  riskLevel: "casual",
  evidenceRequirement: "low",
  freshness: "timeless",
  inputType: "text",
  verificationMethod: "cross_model_consistency",
  requestedCount: null,
  requiresClarification: false,
  rationale: "test fixture",
};

function result(modelId: string, uncertainties: string[], followUps: string[] = []): AdaptiveModelResult {
  return {
    modelId: modelId as any,
    schemaId: "generic",
    ok: true,
    data: { summary: "x", keyClaims: [], uncertainties, followUps },
  };
}

describe("GenericSectionsView — B6 dedup/merge", () => {
  it("merges two paraphrases of the same uncertainty from different models into one bullet", () => {
    const results: AdaptiveModelResult[] = [
      result("chatgpt", [
        "It's unclear how much of the inflation spike was driven by supply chain disruption versus monetary policy.",
      ]),
      result("claude", [
        "The relative contribution of supply chain disruption vs monetary policy to the inflation spike is unclear.",
      ]),
    ];

    const html = renderToStaticMarkup(
      createElement(GenericSectionsView, { schema: SCHEMA_REGISTRY.generic, classification, results, alignedClaims: [] })
    );

    // Rendered as ONE bullet (li), attributed to both models — not two
    // separate near-identical bullets.
    const liMatches = html.match(/<li>/g) || [];
    expect(liMatches.length).toBe(1);
    expect(html).toContain("raised by 2 models");
  });

  it("keeps genuinely distinct uncertainties/follow-ups separate and unattributed when raised by only one model", () => {
    const results: AdaptiveModelResult[] = [
      result(
        "chatgpt",
        ["It's unclear how much of the inflation spike came from supply chain disruption."],
        ["Should we compare this against the 1970s stagflation episode?"]
      ),
      result(
        "claude",
        ["It's unclear whether the labor market will stay this tight through next year."],
        ["What would a 50bps cut in September imply for the terminal rate?"]
      ),
    ];

    const html = renderToStaticMarkup(
      createElement(GenericSectionsView, { schema: SCHEMA_REGISTRY.generic, classification, results, alignedClaims: [] })
    );

    expect((html.match(/<li>/g) || []).length).toBe(4); // 2 uncertainties + 2 follow-ups, none merged
    expect(html).not.toContain("raised by");
  });
});
