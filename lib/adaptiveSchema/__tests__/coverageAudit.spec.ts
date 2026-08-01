/**
 * Bias & Blind Spots Tier 2 Tests (panel coverage audit).
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { auditPanelCoverage } from "@/lib/adaptiveSchema/coverageAudit";

describe("auditPanelCoverage", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns [] without calling the model when there is no claim text", async () => {
    const gaps = await auditPanelCoverage("Q", "generic", []);
    expect(gaps).toEqual([]);
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });

  it("returns parsed gaps, capped at MAX_COVERAGE_GAPS, on success", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({
        gaps: [
          {
            dimension: "Global energy price shocks",
            whyItMatters: "A domain expert would weigh the 2022 energy shock against domestic demand drivers.",
            followUpQuestion: "How much did global energy prices contribute to US inflation versus domestic demand?",
          },
          { dimension: "Fiscal policy lag", whyItMatters: "x", followUpQuestion: "y" },
          { dimension: "Labor market tightness", whyItMatters: "x", followUpQuestion: "y" },
          { dimension: "Fifth dimension over the cap", whyItMatters: "x", followUpQuestion: "y" },
        ],
      }),
      latencyMs: 5,
    });

    const gaps = await auditPanelCoverage("What caused US inflation?", "generic", ["consensus-claim"]);
    expect(gaps).toHaveLength(3);
    expect(gaps[0].dimension).toBe("Global energy price shocks");
  });

  it("degrades to [] on timeout/error, never throws", async () => {
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "boom", latencyMs: 5 });
    await expect(auditPanelCoverage("Q", "generic", ["a"])).resolves.toEqual([]);
  });

  it("degrades to [] on malformed JSON, never throws", async () => {
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: "not json at all", latencyMs: 5 });
    await expect(auditPanelCoverage("Q", "generic", ["a"])).resolves.toEqual([]);
  });

  it("returns [] when the panel's coverage is reported complete", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({ gaps: [] }),
      latencyMs: 5,
    });
    const gaps = await auditPanelCoverage("Q", "generic", ["a"]);
    expect(gaps).toEqual([]);
  });
});
