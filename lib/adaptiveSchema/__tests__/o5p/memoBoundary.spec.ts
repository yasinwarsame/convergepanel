/**
 * Order 5 Contract P — the shared memo generator's adaptive-only boundary (owner decision on O5-D8). The adaptive path
 * is taken only for a research memo carrying exactly { reportKind: "adaptive_research", disagreementPositionVersion: 1 }
 * as own properties; claim and video memos never take it, whatever they carry. Byte-identity of the shared claim /
 * video / legacy-research memos is pinned by historicalParity.spec.tsx against the 2c17feee oracles.
 */
import { generateVerificationMemo, isMarkedAdaptiveResearchMemo, type MemoInput } from "@/lib/verification/generateMemo";

const research: MemoInput = { type: "research", question: "Q?", consensusScore: 61, confidenceLabel: "Medium", evidenceQuality: "mixed", verificationId: "r", synthesisAgreements: ["A"], synthesisDisagreements: ["D"], modelsUsed: ["ChatGPT slot"] };
const boundary = { reportKind: "adaptive_research", disagreementPositionVersion: 1 };

describe("adaptive memo boundary", () => {
  it.each([
    [{ ...research, adaptivePositionPresentation: boundary }, true],
    [{ ...research, adaptivePositionPresentation: { ...boundary, disagreementPositionVersion: "1" } }, false],
    [{ ...research, adaptivePositionPresentation: { ...boundary, disagreementPositionVersion: 2 } }, false],
    [{ ...research, adaptivePositionPresentation: { ...boundary, reportKind: "legacy_panel" } }, false],
    [{ ...research, adaptivePositionPresentation: { ...boundary, extra: true } }, false],
    [{ ...research, adaptivePositionPresentation: { reportKind: "adaptive_research" } }, false],
    [{ ...research, adaptivePositionPresentation: [boundary] }, false],
    [{ ...research, adaptivePositionPresentation: Object.create(boundary) }, false],
    [{ ...research, adaptivePositionPresentation: null }, false],
    [research, false],
    [{ ...research, type: "claim", adaptivePositionPresentation: boundary }, false],
    [{ ...research, type: "video", adaptivePositionPresentation: boundary }, false],
  ])("%#: %j → %s", (input, expected) => {
    expect(isMarkedAdaptiveResearchMemo(input as MemoInput)).toBe(expected);
  });

  it("the adaptive path characterizes no panel agreement; the original research path is unchanged for the same data", () => {
    const marked = generateVerificationMemo({ ...research, adaptivePositionPresentation: boundary as any });
    const original = generateVerificationMemo(research);
    expect(marked).not.toMatch(/WHERE MODELS|CONSENSUS SCORE|diverging themes|\bconverg(e|ed|ence)\b|areas of agreement and disagreement/);
    expect(marked).toContain("UNRESOLVED CLAIMS AND VALUE DIFFERENCES");
    expect(marked).toContain("RUN CERTAINTY: 61/100 (Medium confidence)");
    expect(original).toContain("WHERE MODELS DISAGREE");
    expect(original).toContain("CONSENSUS SCORE: 61/100");
  });

  it("a claim memo carrying the adaptive boundary is still the claim memo", () => {
    const claim: MemoInput = { type: "claim", verdict: "disputed", claim: "X", consensusScore: 40, confidenceLabel: "Low", evidenceQuality: "weak", verificationId: "v", disagreementPoints: ["d"] };
    const norm = (m: string) => m.replace(/^Generated: .*$/m, "Generated: <normalized>");
    expect(norm(generateVerificationMemo({ ...claim, adaptivePositionPresentation: boundary as any }))).toBe(norm(generateVerificationMemo(claim)));
  });
});
