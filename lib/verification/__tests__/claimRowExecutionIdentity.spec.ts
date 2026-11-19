/**
 * Doc 14 PR-1, R4 owner rulings (2026-11-18): per-row executing identity, MINOR-3, the own-provider map, pair
 * multiplicity and the score qualifier on the client surfaces (copied verdict / memo / view / Team / history), named cases.
 * The full space is in claimStatementInventory*.spec.tsx.
 */
jest.mock("server-only", () => ({}));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children }: { children: unknown }) => children }));

import { CONNECTOR_MAP, connectorProvider } from "@/lib/connectors";
import * as Counts from "@/lib/verification/claimVerdictCounts";
import { buildCase, memoFor, MODES } from "./claimStatementInventory.harness";
import { buildClaimVerdictClipboardText } from "@/components/verification/ClaimVerificationResultView";
import { claimHistoryConsensusSuffix } from "@/lib/verification/claimConsensusPresentation";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";

const mode = (name: string) => MODES.find((m) => m.name === name)!;
// Read lazily so a missing export fails the test that needs it (failing-first), not the whole file.
const C = Counts as unknown as Record<string, any>;
const storedClaimHistoryScoreFields = (d: unknown) => require("@/lib/verification/claimStatementBasisSources").storedClaimHistoryScoreFields(d);

describe("per-row executing identity (R4 MINOR-1 / MINOR-3)", () => {
  it("the client-safe own-provider map equals the claim dispatch's connector providers", () => {
    for (const [slot, provider] of Object.entries(C.CLAIM_SLOT_OWN_PROVIDER as Record<string, string>)) {
      expect(connectorProvider(CONNECTOR_MAP[slot as keyof typeof CONNECTOR_MAP])).toBe(provider);
    }
  });

  it("labels", () => {
    expect(C.claimRowExecutionLabel({ modelId: "chatgpt", status: "ok", provider: "openai" })).toBe("ChatGPT");
    expect(C.claimRowExecutionLabel({ modelId: "chatgpt", status: "ok" })).toBe("ChatGPT");
    expect(C.claimRowExecutionLabel({ modelId: "chatgpt", status: "ok", substituted: true, provider: "deepseek" })).toBe("DeepSeek (substituting ChatGPT)");
    expect(C.claimRowExecutionLabel({ modelId: "chatgpt", status: "ok", substituted: true })).toBe("Substitute model (substituting ChatGPT)");
    expect(C.claimRowExecutionLabel({ modelId: "chatgpt", status: "ok", substituted: true, provider: "acme" })).toBe("Substitute model (substituting ChatGPT)");
    // MINOR-3: an own slot recording another provider (registered or not) without the substituted flag.
    expect(C.claimRowExecutionLabel({ modelId: "chatgpt", status: "ok", provider: "anthropic" })).toBe("ChatGPT slot (executing model not identified)");
    expect(C.claimRowExecutionLabel({ modelId: "chatgpt", status: "ok", provider: "acme" })).toBe("ChatGPT slot (executing model not identified)");
    expect(C.claimRowIsOwnModel({ modelId: "chatgpt", status: "ok", provider: "anthropic" })).toBe(false);
    expect(C.claimRowIsOwnModel({ modelId: "chatgpt", status: "ok", provider: "OpenAI " })).toBe(true);
  });

  it("MINOR-3: one distinct provider per slot, but an own slot records another provider → not named own models", () => {
    const rows = [
      { modelId: "chatgpt", status: "ok", verdict: "accurate", provider: "deepseek" },
      { modelId: "claude", status: "ok", verdict: "accurate", provider: "anthropic" },
      { modelId: "gemini", status: "ok", verdict: "inaccurate", provider: "google" },
    ];
    const b = C.claimStatementBasis(rows, 3, C.claimSlotTally(rows));
    expect([b.modelsIdentified, b.oneModelPerSlot, b.namedOwnModels]).toEqual([true, true, false]);
  });

  it("MINOR-3 on the copied verdict and the memo: the row is not named ChatGPT", () => {
    const c = buildCase(["A", "A", "I"], mode("own-slot-records-unflagged-deepseek"));
    expect(buildClaimVerdictClipboardText(c.payload)).toContain("- ChatGPT slot (executing model not identified): Accurate");
    expect(memoFor(c.payload)).toContain("  ChatGPT slot (executing model not identified):    Accurate (high confidence)");
    expect(memoFor(c.payload)).not.toMatch(/independently evaluated by 3 large language models/);
  });
});

describe("the reviewer's mix on the client surfaces (R4)", () => {
  const c = buildCase(["A", "A", "A", "A", "I"], mode("ds:1-4"));

  it("copied verdict: executing names per row, one between-models pair, qualified score", () => {
    const clip = buildClaimVerdictClipboardText(c.payload);
    expect(clip).toContain("- DeepSeek (substituting ChatGPT): Accurate — chatgpt A");
    expect(clip).not.toMatch(/^- ChatGPT:/m);
    expect(clip).toMatch(/^Consensus score: 70 \(High confidence; verdicts split: 4 accurate, 1 inaccurate; computed over panel slot responses, not independent corroboration\)$/m);
    expect(clip.split("\n").filter((l) => l.startsWith("• Conflicting assessments")).length).toBeLessThanOrEqual(1);
  });

  it("memo: executing names under MODEL VERDICTS and a qualified score line", () => {
    const memo = memoFor(c.payload);
    expect(memo).toContain("  DeepSeek (substituting Grok):    Accurate (high confidence)");
    expect(memo).toContain("CONSENSUS SCORE: 70/100 (High confidence; verdicts split: 4 accurate, 1 inaccurate; computed over panel slot responses, not independent corroboration)");
  });

  it("Team row and Personal history: qualified score", () => {
    const item = toTeamClaimVerificationSummary({ verificationId: "v", data: c.doc as never, workspaceId: "w", projectId: null, project: null });
    expect(item?.consensusBasis).toBe("slot_responses");
    expect(claimHistoryConsensusSuffix(require("@/lib/verification/claimStatementBasisSources").storedClaimHistoryRowFields(c.doc as never))).toBe(" · 70 consensus (computed over panel slot responses, not independent corroboration)");
  });

  it("control: five own models — no qualifier anywhere", () => {
    const own = buildCase(["A", "A", "A", "A", "I"], mode("own"));
    expect(buildClaimVerdictClipboardText(own.payload)).not.toContain("not independent corroboration");
    expect(memoFor(own.payload)).not.toContain("not independent corroboration");
    expect(claimHistoryConsensusSuffix(require("@/lib/verification/claimStatementBasisSources").storedClaimHistoryRowFields(own.doc as never))).toBe(" · 70 consensus");
  });
});
