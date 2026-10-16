/**
 * Consensus Integrity — provenance through alignment (D2, D8, D11)
 *
 * Field origin (settled / disputed / unclassified) survives pass 1 and the
 * pass-2 semantic cluster; the clusterer receives stance, confidence and
 * origin as separate typed fields; inferred (backfilled) and field-derived
 * cells carry no synthetic confidence; and a null confidence scores certainty
 * exactly as the legacy "majority_view" placeholder did.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { alignClaims, formatClusterGroupsForPrompt, ClaimNode, ModelClaims } from "@/lib/adaptiveSchema/alignment";
import { alignMetrics, alignScalarField, alignScenarios, alignSteps } from "@/lib/adaptiveSchema/fieldAlignment";
import { scoreClaimCertainty } from "@/lib/adaptiveSchema/scoring";
import { UNSTATED_CONFIDENCE_CERTAINTY_SCORE, STATED_CONFIDENCE_SCORE, cellConfidenceCertaintyScore } from "@/lib/adaptiveSchema/config";
import { AlignedClaim, AlignedClaimCell, Claim } from "@/lib/adaptiveSchema/types";

function claim(overrides: Partial<Claim> & Pick<Claim, "id" | "claim">): Claim {
  return { stance: "asserts", confidence: "settled", evidenceType: "empirical", ...overrides };
}

const failAll = async () => ({ modelId: "gemini" as const, status: "error" as const, rawText: null, errorMessage: "forced", latencyMs: 1 });

afterEach(() => jest.clearAllMocks());

describe("field origin survives alignment", () => {
  it("pass 1 (slug merge, no cluster call): each cell keeps its own field and class", async () => {
    mockedCallGemini.mockImplementation(failAll);
    const perModelClaims: ModelClaims[] = [
      {
        modelId: "chatgpt",
        claims: [claim({ id: "carbon-pricing-works", claim: "Carbon pricing works." })],
        claimOrigins: [{ field: "settledClaims", fieldClass: "settled" }],
      },
      {
        modelId: "claude",
        claims: [claim({ id: "carbon-pricing-works", claim: "Carbon pricing works.", confidence: "contested" })],
        claimOrigins: [{ field: "disputedClaims", fieldClass: "disputed" }],
      },
    ];
    const [row] = await alignClaims(perModelClaims);
    expect(row.cells[0]!.origin).toEqual({ kind: "claim", field: "settledClaims", fieldClass: "settled" });
    expect(row.cells[1]!.origin).toEqual({ kind: "claim", field: "disputedClaims", fieldClass: "disputed" });
    expect(row.cells[1]!.confidence).toBe("contested");
  });

  it("pass 2 (semantic cluster merges different slugs): origin follows each member, not the cluster", async () => {
    mockedCallGemini.mockImplementation(async (userMessage: any) => {
      const text = String(userMessage);
      if (text.includes("c0:")) {
        return {
          modelId: "gemini",
          status: "ok",
          rawText: JSON.stringify({
            clusters: [
              {
                canonicalText: "Relative effectiveness of carbon pricing mechanisms",
                members: [
                  { key: "c0", stance: "agrees", excerpt: "Taxes outperform" },
                  { key: "c1", stance: "disputes", excerpt: "Trading is as good" },
                ],
              },
            ],
          }),
          latencyMs: 1,
        };
      }
      return failAll();
    });
    const perModelClaims: ModelClaims[] = [
      {
        modelId: "chatgpt",
        claims: [claim({ id: "taxes-outperform", claim: "Carbon taxes outperform trading." })],
        claimOrigins: [{ field: "disputedClaims", fieldClass: "disputed" }],
      },
      {
        modelId: "grok",
        claims: [claim({ id: "trading-equivalent", claim: "Cap-and-trade achieves similar cuts." })],
        claimOrigins: [{ field: "settledClaims", fieldClass: "settled" }],
      },
    ];
    const [row] = await alignClaims(perModelClaims);
    expect(row.claimText).toBe("Relative effectiveness of carbon pricing mechanisms");
    expect(row.cells[0]!.origin).toEqual({ kind: "claim", field: "disputedClaims", fieldClass: "disputed" });
    expect(row.cells[1]!.origin).toEqual({ kind: "claim", field: "settledClaims", fieldClass: "settled" });
  });

  it("claimOrigins whose length doesn't match claims is ignored — unclassified, never a guessed 'disputed'", async () => {
    mockedCallGemini.mockImplementation(failAll);
    const [row] = await alignClaims([
      {
        modelId: "chatgpt",
        claims: [claim({ id: "a", claim: "A." }), claim({ id: "b-different", claim: "B." })],
        claimOrigins: [{ field: "disputedClaims", fieldClass: "disputed" }],
      },
    ]);
    expect(row.cells[0]!.origin).toEqual({ kind: "claim", field: null, fieldClass: "unclassified" });
  });
});

describe("pass-2 clusterer input: typed fields, not a folded label", () => {
  const nodes: ClaimNode[] = [
    { modelId: "chatgpt", claim: claim({ id: "x", claim: 'Says "X" holds.', stance: "asserts", confidence: "contested" }), field: "disputedClaims", fieldClass: "disputed" },
    { modelId: "claude", claim: claim({ id: "y", claim: "Y holds.", stance: "uncertain", confidence: "settled" }), field: "settledClaims", fieldClass: "settled" },
  ];

  it("one `c<i>:` line per group whose payload parses as JSON with separate stance, confidence and fieldClass", () => {
    const message = formatClusterGroupsForPrompt([[0], [1]], nodes);
    const lines = message.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => {
      const m = /^c(\d+): (.*)$/.exec(l);
      expect(m).not.toBeNull();
      return { key: Number(m![1]), members: JSON.parse(m![2]) };
    });
    expect(parsed[0]).toEqual({
      key: 0,
      members: [{ model: "chatgpt", claim: 'Says "X" holds.', stance: "asserts", confidence: "contested", fieldClass: "disputed" }],
    });
    expect(parsed[1].members[0]).toEqual({ model: "claude", claim: "Y holds.", stance: "uncertain", confidence: "settled", fieldClass: "settled" });
    // No synthetic "(stance: …)" label string folding the fields together.
    expect(message).not.toMatch(/\(stance:/);
  });

  it("the live cluster call sends that input, and the system prompt says confidence/fieldClass are not a position", async () => {
    mockedCallGemini.mockImplementation(failAll);
    await alignClaims([
      { modelId: "chatgpt", claims: [claim({ id: "aaa-one", claim: "One.", confidence: "contested" })], claimOrigins: [{ field: "disputedClaims", fieldClass: "disputed" }] },
      { modelId: "claude", claims: [claim({ id: "zzz-two", claim: "Two." })], claimOrigins: [{ field: "settledClaims", fieldClass: "settled" }] },
    ]);
    const clusterCall = mockedCallGemini.mock.calls.find(([msg]) => String(msg).startsWith("c0:"));
    expect(clusterCall).toBeDefined();
    const [message, , , opts] = clusterCall!;
    expect(JSON.parse(String(message).split("\n")[0].replace(/^c0: /, ""))[0]).toMatchObject({ confidence: "contested", fieldClass: "disputed" });
    const systemPrompt = String((opts as { systemPromptOverride?: string }).systemPromptOverride);
    expect(systemPrompt).toContain('"confidence"');
    expect(systemPrompt).toContain('"fieldClass"');
    expect(systemPrompt).toContain("They are NOT the model's position");
  });
});

describe("inferred cells carry no synthetic confidence", () => {
  it("a backfilled cell has confidence null, origin inferred and backfilled true", async () => {
    mockedCallGemini.mockImplementation(async (userMessage: any) => {
      const text = String(userMessage);
      if (text.includes("q0: Shared proposition.")) {
        return {
          modelId: "gemini",
          status: "ok",
          rawText: JSON.stringify({ answers: [{ key: "q0", hasPosition: true, stance: "agrees", excerpt: "implied agreement" }] }),
          latencyMs: 1,
        };
      }
      return failAll();
    });
    const rows = await alignClaims([
      { modelId: "chatgpt", claims: [claim({ id: "shared-proposition", claim: "Shared proposition." })], claimOrigins: [{ field: "keyClaims", fieldClass: "unclassified" }] },
      { modelId: "claude", claims: [claim({ id: "zzz-unrelated-thing", claim: "Unrelated." })], claimOrigins: [{ field: "keyClaims", fieldClass: "unclassified" }] },
    ]);
    const shared = rows.find((r) => r.claimText === "Shared proposition.")!;
    expect(shared.cells[1]).toMatchObject({ backfilled: true, origin: { kind: "inferred" }, confidence: null });
    expect(shared.cells[1]!.camps).toBeUndefined();
  });
});

describe("field-derived cells carry no synthetic confidence", () => {
  it("metric, scenario, step and scalar cells: confidence null, origin field_derived with their field type", () => {
    const metricRow = alignMetrics([
      { modelId: "chatgpt", metrics: [{ label: "Revenue", value: 10, unit: "USD", asOf: "2026", source: "x" } as any] },
    ])[0];
    const scenarioRow = alignScenarios([
      { modelId: "chatgpt", scenarios: [{ label: "Base", probability: 0.5, narrative: "n" } as any] },
    ])[0];
    const stepRow = alignSteps([{ modelId: "chatgpt", steps: [{ order: 1, action: "Do it" } as any] }])[0];
    const scalarRow = alignScalarField([{ modelId: "chatgpt", value: "Paris" }], "answer", "Answer", "exact_normalized");

    const expectations: [AlignedClaim, string][] = [
      [metricRow, "metric"],
      [scenarioRow, "scenario"],
      [stepRow, "step"],
      [scalarRow, "scalar"],
    ];
    for (const [row, fieldType] of expectations) {
      const c = row.cells[0] as AlignedClaimCell;
      expect(c.confidence).toBeNull();
      expect(c.origin).toEqual({ kind: "field_derived", fieldType });
    }
  });
});

describe("certainty: a null confidence scores exactly like the legacy placeholder", () => {
  it("UNSTATED_CONFIDENCE_CERTAINTY_SCORE is the old majority_view weight", () => {
    expect(UNSTATED_CONFIDENCE_CERTAINTY_SCORE).toBe(STATED_CONFIDENCE_SCORE.majority_view);
    expect(cellConfidenceCertaintyScore(null)).toBe(STATED_CONFIDENCE_SCORE.majority_view);
    expect(cellConfidenceCertaintyScore("contested")).toBe(STATED_CONFIDENCE_SCORE.contested);
  });

  it("a row whose inferred cells carry null scores the same certainty as the same row with the legacy 'majority_view'", () => {
    const base = (confidence: AlignedClaimCell["confidence"]): AlignedClaim => ({
      id: "r",
      claimText: "r",
      cells: [
        { modelId: "chatgpt", stance: "agrees", rawStance: "asserts", confidence: "contested", excerpt: "e" },
        { modelId: "claude", stance: "agrees", rawStance: "asserts", confidence, excerpt: "e", backfilled: true },
        null,
      ],
      agreementScore: 0.8,
      certaintyScore: 0,
      status: "consensus",
    });
    const [legacy] = scoreClaimCertainty([base("majority_view")], 3);
    const [current] = scoreClaimCertainty([base(null)], 3);
    expect(current.certaintyScore).toBe(legacy.certaintyScore);
  });
});
