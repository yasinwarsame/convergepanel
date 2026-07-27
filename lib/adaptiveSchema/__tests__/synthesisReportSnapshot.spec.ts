/**
 * Synthesis Report structure snapshots, per schema type (R5).
 *
 * Uses the degraded template path (narrative model call mocked to fail) so
 * the snapshot captures STRUCTURE — which sections exist and how they're
 * populated from the scored rows — without depending on non-deterministic
 * model prose. All 9 schema types must always produce the same 5 required
 * sections: unifiedAnswer, panelVerdict, gate, whereModelsAgree,
 * whereModelsDisagree, certaintyAssessment.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { AlignedClaim, AlignedClaimCell, QueryType } from "@/lib/adaptiveSchema/types";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";

function cell(modelId: string, stance: AlignedClaimCell["stance"]): AlignedClaimCell {
  return { modelId: modelId as any, stance, rawStance: "asserts", confidence: "majority_view", excerpt: `${modelId} excerpt` };
}

function fixtureRows(): AlignedClaim[] {
  return [
    {
      id: "consensus-claim",
      claimText: "Consensus claim",
      cells: [cell("chatgpt", "agrees"), cell("claude", "agrees"), cell("grok", "agrees")],
      agreementScore: 1,
      certaintyScore: 0.9,
      status: "consensus",
    },
    {
      id: "split-claim",
      claimText: "Split claim",
      cells: [cell("chatgpt", "disputes"), cell("claude", "agrees")],
      agreementScore: 0.3,
      certaintyScore: 0.3,
      status: "split",
    },
  ];
}

describe("buildAdaptiveSynthesisReport structure snapshots (per schema type)", () => {
  beforeEach(() => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "error",
      rawText: null,
      errorMessage: "forced degraded path for structural snapshot",
      latencyMs: 5,
    });
  });
  afterEach(() => jest.clearAllMocks());

  const schemaIds = Object.keys(SCHEMA_REGISTRY) as QueryType[];

  it.each(schemaIds)("has all 5 required sections for schema %s", async (schemaId) => {
    const report = await buildAdaptiveSynthesisReport("Test question", schemaId, fixtureRows(), 5);

    expect(report).toMatchSnapshot({
      // unifiedAnswer/panelVerdict/certaintyAssessment text is deterministic
      // given the fixture above, so no need to loosen those.
    });

    // Structural invariants every schema must satisfy, independent of the snapshot file.
    expect(typeof report.unifiedAnswer).toBe("string");
    expect(typeof report.panelVerdict).toBe("string");
    expect(["pass", "caution", "fail"]).toContain(report.gate);
    expect(Array.isArray(report.whereModelsAgree)).toBe(true);
    expect(Array.isArray(report.whereModelsDisagree)).toBe(true);
    expect(typeof report.certaintyAssessment).toBe("string");
    expect(report.degraded).toBe(true);
  });
});
