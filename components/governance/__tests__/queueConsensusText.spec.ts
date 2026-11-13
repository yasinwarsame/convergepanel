/**
 * M2 — GovernanceDashboard queue table cell and review modal "Consensus:" text. A research row whose stored score the
 * queue route withheld (`consensusWithheld`: fewer than two independent executing models, or independence not
 * recorded) shows the reason, never a number; other rows are unchanged.
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

import { queueConsensusText } from "@/components/governance/GovernanceDashboard";
import { CONSENSUS_WITHHELD_TEXT } from "@/lib/panel/independentVoices";

describe("queueConsensusText", () => {
  it.each([
    ["insufficient_independent_models", CONSENSUS_WITHHELD_TEXT.insufficient_independent_models],
    ["independence_unverified", CONSENSUS_WITHHELD_TEXT.independence_unverified],
  ] as const)("withheld (%s) → the reason, even if a score were present", (reason, text) => {
    for (const withDenominator of [true, false]) {
      expect(queueConsensusText({ consensusScore: null, consensusWithheld: reason }, withDenominator)).toBe(text);
      expect(queueConsensusText({ consensusScore: 90, consensusWithheld: reason }, withDenominator)).toBe(text);
    }
  });

  it("not withheld: score as before ('90/100' in the modal, '90' in the table, '—' when absent)", () => {
    expect(queueConsensusText({ consensusScore: 89.6 }, true)).toBe("90/100");
    expect(queueConsensusText({ consensusScore: 89.6 }, false)).toBe("90");
    expect(queueConsensusText({ consensusScore: null }, true)).toBe("—");
  });
});
