/**
 * Claim Alignment Tests
 *
 * Covers slug matching (exact, fuzzy, no-match), the three-pass alignment
 * pipeline (slug pre-merge → semantic proposition clustering → stance
 * backfill for silent cells), and the R3 regression fixture: claims with
 * OPPOSING stances about the same underlying proposition, phrased with
 * unrelated self-assigned slugs (the original under-clustering bug), must
 * land in one row with differing stances rather than as silent singletons.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { alignClaims, slugsMatch, ModelClaims } from "@/lib/adaptiveSchema/alignment";
import { AlignedClaim, Claim } from "@/lib/adaptiveSchema/types";

function claim(overrides: Partial<Claim> & Pick<Claim, "id" | "claim">): Claim {
  return {
    stance: "asserts",
    confidence: "settled",
    evidenceType: "empirical",
    ...overrides,
  };
}

function countCells(rows: AlignedClaim[]): { total: number; nonNull: number } {
  let total = 0;
  let nonNull = 0;
  for (const row of rows) {
    for (const cell of row.cells) {
      total += 1;
      if (cell) nonNull += 1;
    }
  }
  return { total, nonNull };
}

describe("slugsMatch", () => {
  it("matches identical slugs", () => {
    expect(slugsMatch("demand-pull-inflation", "demand-pull-inflation")).toBe(true);
  });

  it("matches slugs within normalized Levenshtein 0.3", () => {
    expect(slugsMatch("demand-pull-inflation", "demand-pull-inflaton")).toBe(true); // 1-char typo
  });

  it("matches slugs with a shared token stem", () => {
    expect(slugsMatch("rate-cuts-boost-growth", "rate-cuts-help-growth")).toBe(true);
  });

  it("does not match unrelated slugs", () => {
    expect(slugsMatch("demand-pull-inflation", "supply-chain-disruption")).toBe(false);
  });
});

describe("alignClaims", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns an empty array when no model raised any claims", async () => {
    const result = await alignClaims([
      { modelId: "chatgpt", claims: [] },
      { modelId: "claude", claims: [] },
    ]);
    expect(result).toEqual([]);
  });

  it("merges an exact slug match across two models into one row (pass 1, no model call)", async () => {
    const perModelClaims: ModelClaims[] = [
      { modelId: "chatgpt", claims: [claim({ id: "demand-pull-driver", claim: "Demand-pull effects dominate." })] },
      { modelId: "claude", claims: [claim({ id: "demand-pull-driver", claim: "Demand pull is the main driver.", stance: "disputes" })] },
    ];

    const result = await alignClaims(perModelClaims);

    expect(result).toHaveLength(1);
    expect(result[0].cells).toHaveLength(2);
    // Fallback relative-stance mapping: asserts -> agrees, disputes -> disputes.
    expect(result[0].cells[0]).toMatchObject({ modelId: "chatgpt", stance: "agrees", rawStance: "asserts" });
    expect(result[0].cells[1]).toMatchObject({ modelId: "claude", stance: "disputes", rawStance: "disputes" });
    // Only one group exists post slug-merge — nothing to reconcile, and no null cells to backfill.
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });

  it("merges a fuzzy slug match across two models", async () => {
    const perModelClaims: ModelClaims[] = [
      { modelId: "chatgpt", claims: [claim({ id: "wage-price-spiral", claim: "A wage-price spiral is underway." })] },
      { modelId: "claude", claims: [claim({ id: "wage-price-spirals", claim: "Wage-price spirals are occurring." })] },
    ];

    const result = await alignClaims(perModelClaims);

    expect(result).toHaveLength(1);
    expect(result[0].cells.filter(Boolean)).toHaveLength(2);
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });

  it("keeps a single-model claim as-is when there's nothing to merge or backfill against", async () => {
    const perModelClaims: ModelClaims[] = [
      { modelId: "chatgpt", claims: [claim({ id: "only-claim", claim: "Only one model said this." })] },
    ];

    const result = await alignClaims(perModelClaims);

    expect(result).toHaveLength(1);
    expect(result[0].cells).toEqual([
      {
        modelId: "chatgpt",
        stance: "agrees",
        rawStance: "asserts",
        confidence: "settled",
        excerpt: "Only one model said this.",
        evidenceType: "empirical",
      },
    ]);
    // Only one group total, and the sole model isn't silent on its own claim — no model call needed.
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });

  it("falls back to unmerged singletons (with attempted backfill) when the semantic cluster call fails", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "error",
      rawText: null,
      errorMessage: "boom",
      latencyMs: 5,
    });

    const perModelClaims: ModelClaims[] = [
      { modelId: "chatgpt", claims: [claim({ id: "alpha-claim-here", claim: "Claim A." })] },
      { modelId: "claude", claims: [claim({ id: "zeta-thing-elsewhere", claim: "Claim B." })] },
    ];

    const result = await alignClaims(perModelClaims);

    // No slug match and the cluster call failed -> two separate rows, no crash.
    expect(result).toHaveLength(2);
    // 1 cluster-call attempt + 1 backfill attempt per model (each has a null
    // cell in the other's row) = 3 calls, all degraded to "leave null".
    expect(mockedCallGemini).toHaveBeenCalledTimes(3);
    expect(result.every((row) => row.cells.filter(Boolean).length === 1)).toBe(true);
  });

  it("merges no-slug-match claims when the semantic cluster call succeeds", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({
        clusters: [
          {
            canonicalText: "Interest rate trajectory",
            members: [
              { key: "c0", stance: "agrees", excerpt: "Rates keep climbing." },
              { key: "c1", stance: "agrees", excerpt: "The Fed keeps hiking." },
            ],
          },
        ],
      }),
      latencyMs: 5,
    });

    const perModelClaims: ModelClaims[] = [
      { modelId: "chatgpt", claims: [claim({ id: "rates-will-rise", claim: "Interest rates will keep climbing." })] },
      { modelId: "claude", claims: [claim({ id: "hikes-continue", claim: "The Fed will keep hiking." })] },
    ];

    const result = await alignClaims(perModelClaims);

    expect(result).toHaveLength(1);
    expect(result[0].claimText).toBe("Interest rate trajectory");
    expect(result[0].cells.filter(Boolean)).toHaveLength(2);
    // Both models resolved in the single cluster -> no null cells left to backfill.
    expect(mockedCallGemini).toHaveBeenCalledTimes(1);
  });

  it("R3 regression: opposing-stance claims about the same proposition, under unrelated slugs, merge into one row instead of staying silent singletons", async () => {
    // Mirrors the reported bug: Grok's cap-and-trade claim and Perplexity's
    // outperform-ETS claim are the SAME proposition argued from opposite
    // sides, but each model invented an unrelated-looking slug for it.
    const perModelClaims: ModelClaims[] = [
      {
        modelId: "chatgpt",
        claims: [claim({ id: "tax-design-quality-matters", claim: "Design quality matters more than mechanism choice.", stance: "uncertain" })],
      },
      {
        modelId: "claude",
        claims: [claim({ id: "flexibility-favors-cap-and-trade", claim: "Cap-and-trade is more flexible for firms.", stance: "asserts" })],
      },
      {
        modelId: "grok",
        claims: [claim({ id: "similar-reduction-outcomes", claim: "Cap-and-trade achieves similar emissions reductions to a carbon tax.", stance: "asserts" })],
      },
      {
        modelId: "perplexity",
        claims: [claim({ id: "pricing-mechanism-comparison", claim: "Carbon taxes often outperform emissions trading systems in reducing emissions.", stance: "asserts" })],
      },
      {
        modelId: "gemini",
        claims: [claim({ id: "renewable-investment-primary-driver", claim: "Renewable investment matters more than pricing mechanism choice.", stance: "uncertain" })],
      },
    ];

    mockedCallGemini.mockImplementation(async (userMessage: any) => {
      const text = String(userMessage);
      if (text.includes("c0:")) {
        // The semantic clustering call — sees all 5 pass-1 singleton groups.
        return {
          modelId: "gemini",
          status: "ok",
          rawText: JSON.stringify({
            clusters: [
              {
                canonicalText: "Carbon taxes are more effective than cap-and-trade at reducing emissions",
                members: [
                  { key: "c0", stance: "partial", excerpt: "Design quality matters more than mechanism" },
                  { key: "c1", stance: "disputes", excerpt: "Cap-and-trade is more flexible for firms" },
                  { key: "c2", stance: "disputes", excerpt: "Cap-and-trade achieves similar reductions" },
                  { key: "c3", stance: "agrees", excerpt: "Carbon taxes often outperform ETS" },
                ],
              },
              {
                canonicalText: "Renewable energy investment is the primary driver of emissions reductions",
                members: [{ key: "c4", stance: "agrees", excerpt: "Renewable investment matters more" }],
              },
            ],
          }),
          latencyMs: 5,
        };
      }
      if (text.includes("Carbon taxes are more effective than cap-and-trade")) {
        // Gemini's backfill check against the pricing-mechanism cluster.
        return {
          modelId: "gemini",
          status: "ok",
          rawText: JSON.stringify({
            answers: [{ key: "q0", hasPosition: true, stance: "partial", excerpt: "Renewables matter more than mechanism choice" }],
          }),
          latencyMs: 5,
        };
      }
      if (text.includes("Renewable energy investment is the primary driver")) {
        // chatgpt/claude/grok/perplexity backfill checks against the renewables cluster.
        return {
          modelId: "gemini",
          status: "ok",
          rawText: JSON.stringify({
            answers: [{ key: "q0", hasPosition: true, stance: "unclear", excerpt: "Doesn't directly address renewables" }],
          }),
          latencyMs: 5,
        };
      }
      return { modelId: "gemini", status: "error", rawText: null, errorMessage: "unexpected call", latencyMs: 5 };
    });

    const result = await alignClaims(perModelClaims);

    expect(result).toHaveLength(2);

    const pricingRow = result.find((r) => r.claimText.includes("Carbon taxes are more effective"));
    expect(pricingRow).toBeDefined();

    const grokCell = pricingRow!.cells.find((c) => c?.modelId === "grok");
    const perplexityCell = pricingRow!.cells.find((c) => c?.modelId === "perplexity");
    expect(grokCell).toMatchObject({ stance: "disputes" });
    expect(perplexityCell).toMatchObject({ stance: "agrees" });

    // Both landed in ONE row, not two silent singletons.
    expect(pricingRow!.cells.filter(Boolean).length).toBeGreaterThanOrEqual(2);

    // Backfill filled in the rest of this cluster too (gemini via explicit
    // backfill), and the overall matrix clears the 60% non-null bar.
    const { total, nonNull } = countCells(result);
    expect(nonNull / total).toBeGreaterThanOrEqual(0.6);

    // 1 cluster call + 5 per-model backfill calls (every model has exactly
    // one null cell to check against the other cluster).
    expect(mockedCallGemini).toHaveBeenCalledTimes(6);
  });

  it("B3 regression: a model's summary asserting a claim it never listed explicitly backfills as stance=agrees with the summary excerpt", async () => {
    // chatgpt and grok both explicitly list "the policy is broadly
    // effective" (exact slug match, no model call needed for that row).
    // claude never lists that claim, but its `summary` field (part of its
    // full response, not its claims array) plainly asserts it — this is
    // the exact reported bug: extraction only looked at claims[], so the
    // implied stance in prose was missed and claude showed "—" on that row.
    const perModelClaims: ModelClaims[] = [
      {
        modelId: "chatgpt",
        claims: [claim({ id: "policy-broadly-effective", claim: "The policy is broadly effective at cutting emissions." })],
      },
      {
        modelId: "claude",
        claims: [claim({ id: "totally-unrelated-topic", claim: "Something about coal plant closures." })],
        fullResponseData: {
          summary: "The policy has proven broadly effective at cutting emissions across most regions studied.",
        },
      },
      {
        modelId: "grok",
        claims: [claim({ id: "policy-broadly-effective", claim: "The policy broadly works to cut emissions." })],
      },
    ];

    mockedCallGemini.mockImplementation(async (userMessage: any) => {
      const text = String(userMessage);
      if (text.includes("c0:")) {
        // Force the semantic cluster call to fail so pass-1 groups
        // (chatgpt+grok merged by exact slug match, claude separate) stay
        // unmerged — isolates this test to pass-3 backfill behavior.
        return { modelId: "gemini", status: "error", rawText: null, errorMessage: "forced failure for isolation", latencyMs: 5 };
      }
      if (text.includes("q0: The policy is broadly effective at cutting emissions")) {
        // claude's backfill check against the policy-effectiveness row (the
        // proposition it's being ASKED about, not merely mentioned in its
        // own claims list — that phrasing also appears in chatgpt/grok's
        // unrelated backfill calls since it's part of THEIR claims list).
        return {
          modelId: "gemini",
          status: "ok",
          rawText: JSON.stringify({
            answers: [{ key: "q0", hasPosition: true, stance: "agrees", excerpt: "Policy has proven broadly effective at cutting emissions" }],
          }),
          latencyMs: 5,
        };
      }
      // chatgpt/grok's backfill checks against claude's coal-plant row — not under test.
      return { modelId: "gemini", status: "error", rawText: null, errorMessage: "not under test", latencyMs: 5 };
    });

    const result = await alignClaims(perModelClaims);

    const policyRow = result.find((r) => r.claimText === "The policy is broadly effective at cutting emissions.");
    expect(policyRow).toBeDefined();

    const claudeCell = policyRow!.cells.find((c) => c?.modelId === "claude");
    expect(claudeCell).toMatchObject({ stance: "agrees", backfilled: true });
    expect(claudeCell!.excerpt).toContain("broadly effective");

    // Prove the FULL response (not just the claims array) was actually sent
    // to the model — the fix this test guards against regressing.
    const claudeBackfillCall = mockedCallGemini.mock.calls.find(([msg]: [unknown]) =>
      String(msg).includes("q0: The policy is broadly effective at cutting emissions")
    );
    expect(claudeBackfillCall).toBeDefined();
    const claudeBackfillMessage = String(claudeBackfillCall![0]);
    expect(claudeBackfillMessage).toContain("summary:");
    expect(claudeBackfillMessage).toContain("broadly effective at cutting emissions across most regions studied");
  });
});
