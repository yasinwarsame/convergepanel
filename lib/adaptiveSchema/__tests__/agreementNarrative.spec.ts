/**
 * Agreement narrative (D9, R3 correction — Option B)
 *
 * The one deterministic renderer of the panel's agreement: exact wording per
 * status, from structured counts only; exhaustive over the statuses; an
 * unknown status is never agreement.
 */

import {
  NO_CONSENSUS_IDENTIFIED,
  PANEL_STATUS_PHRASE,
  ROW_AGREEMENT_WORDING,
  panelAgreementFacts,
  renderPanelAgreement,
  renderRowAgreement,
  rowAgreementFacts,
} from "@/lib/adaptiveSchema/agreementNarrative";
import { ALIGNED_CLAIM_STATUSES, AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const CLAIM = { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } as const;

function row(status: string, stances: (AlignedClaimCell["stance"] | null)[], extra: Partial<AlignedClaim> = {}): AlignedClaim {
  return {
    id: `row-${status}`,
    claimText: `Claim ${status}`,
    cells: M.map((m, i) => {
      const s = stances[i];
      return s ? { modelId: m as ModelId, stance: s, rawStance: "asserts", confidence: "settled", excerpt: "e", origin: CLAIM } : null;
    }),
    agreementScore: 0.5,
    certaintyScore: 0.5,
    status: status as AlignedClaim["status"],
    ...extra,
  };
}

const say = (r: AlignedClaim, dispatched = 5) => renderRowAgreement(rowAgreementFacts(r, dispatched));

describe("renderRowAgreement — exact wording per status", () => {
  it("consensus every dispatched model supports", () => {
    expect(say(row("consensus", ["agrees", "agrees", "partial", "agrees", "agrees"]))).toBe("consensus: all 5 dispatched models support it");
  });

  it("consensus some models were silent on — the count, never 'all'", () => {
    expect(say(row("consensus", ["agrees", "agrees", "agrees", null, null]))).toBe("consensus: 3 of 5 dispatched models support it");
  });

  it("majority, with and without dissent — never unanimity", () => {
    expect(say(row("majority", ["agrees", "agrees", "agrees", "disputes", null]))).toBe(
      "majority: 3 of 5 dispatched models support it, 1 disputes it"
    );
    const allFive = say(row("majority", ["agrees", "partial", "partial", "agrees", "partial"]));
    expect(allFive).toBe("majority: 5 of 5 dispatched models support it");
    expect(allFive).not.toMatch(/\ball\b|unanim/);
  });

  it.each([
    ["majority, 0 disputing", "majority", ["agrees", "agrees", "agrees", null, null], "majority: 3 of 5 dispatched models support it"],
    ["majority, 1 disputing", "majority", ["agrees", "agrees", "agrees", "disputes", null], "majority: 3 of 5 dispatched models support it, 1 disputes it"],
    ["majority, 2 disputing", "majority", ["agrees", "agrees", "agrees", "disputes", "disputes"], "majority: 3 of 5 dispatched models support it, 2 dispute it"],
    ["split, 0 disputing", "split", ["agrees", "unclear", "unclear", null, null], "split: 1 of 5 dispatched models support it and 0 dispute it"],
    ["split, 1 disputing", "split", ["agrees", "disputes", null, null, null], "split: 1 of 5 dispatched models support it and 1 disputes it"],
    ["split, 3 disputing", "split", ["agrees", "disputes", "disputes", "agrees", "disputes"], "split: 2 of 5 dispatched models support it and 3 dispute it"],
  ])("verb agreement (R4-5): %s", (_name, status, stances, expected) => {
    expect(say(row(status as string, stances as (AlignedClaimCell["stance"] | null)[]))).toBe(expected);
  });

  it("limited coverage names the assessed denominator", () => {
    expect(say(row("limited_coverage", ["agrees", "agrees", null, null, null]))).toBe(
      "limited coverage: only 2 of 5 dispatched models took a position — too few to count as agreement"
    );
  });

  it("limited coverage counts assessed positions, not listed cells (an unclear cell took no position)", () => {
    expect(say(row("limited_coverage", ["agrees", "agrees", "unclear", null, null]))).toBe(
      "limited coverage: only 2 of 5 dispatched models took a position — too few to count as agreement"
    );
  });

  it("split gives both sides and is never agreement", () => {
    const text = say(row("split", ["agrees", "disputes", "disputes", "agrees", "disputes"]));
    expect(text).toBe("split: 2 of 5 dispatched models support it and 3 dispute it");
    expect(text).not.toMatch(/consensus|majority|agree/);
  });

  it("single source is one model, never plural agreement", () => {
    expect(say(row("single_source", ["agrees", null, null, null, null]))).toBe(
      "single source: only 1 of 5 dispatched models raised it — not panel agreement"
    );
  });

  it("the canonical contested note is appended from the structured dimensions", () => {
    const contested = row("consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"], {
      contested: { marked: true, assessed: false, markedCount: 5, listedCount: 5 },
    });
    expect(say(contested)).toBe("consensus: all 5 dispatched models support it; all 5 models that listed this claim mark it contested");
    const unmarked = row("consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"], {
      contested: { marked: false, assessed: true, markedCount: 0, listedCount: 5 },
    });
    expect(say(unmarked)).toBe("consensus: all 5 dispatched models support it");
  });

  it("an unknown (future or malformed) status is rendered as unrecognised, never as agreement", () => {
    const text = say(row("near_consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]));
    expect(text).toBe('unrecognised status "near_consensus" — not presented as agreement');
    expect(text).not.toMatch(/support|consensus:|majority/);
  });
});

describe("exhaustiveness", () => {
  it("every known status has row wording and a panel phrase, and no other key exists", () => {
    expect(Object.keys(ROW_AGREEMENT_WORDING).sort()).toEqual([...ALIGNED_CLAIM_STATUSES].sort());
    expect(Object.keys(PANEL_STATUS_PHRASE).sort()).toEqual([...ALIGNED_CLAIM_STATUSES].sort());
  });

  it.each([...ALIGNED_CLAIM_STATUSES])("%s renders its own wording, not the unrecognised fallback", (status) => {
    const text = say(row(status, ["agrees", "agrees", "agrees", "disputes", null]));
    expect(text.startsWith(status === "limited_coverage" ? "limited coverage:" : status === "single_source" ? "single source:" : `${status}:`)).toBe(true);
    expect(text).not.toContain("unrecognised");
  });
});

describe("renderPanelAgreement", () => {
  const statement = (rows: AlignedClaim[], dispatched = 5) => renderPanelAgreement(panelAgreementFacts(rows, dispatched));

  it("lists each status present, strongest first", () => {
    expect(
      statement([
        row("split", ["agrees", "disputes"]),
        row("consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"]),
        row("single_source", ["agrees"]),
        row("majority", ["agrees", "agrees", "agrees", "disputes"]),
        row("limited_coverage", ["agrees", "agrees"]),
      ])
    ).toBe(
      "Of 5 scored claims across 5 dispatched models: consensus on 1; majority agreement on 1; limited coverage on 1 (half or fewer of the dispatched models took a position — too few to count as agreement); a split on 1; a single source only on 1."
    );
  });

  it.each([
    ["split only", [row("split", ["agrees", "disputes"])]],
    ["limited only", [row("limited_coverage", ["agrees", "agrees"])]],
    ["single source only", [row("single_source", ["agrees"])]],
    ["unknown status only", [row("near_consensus", ["agrees", "agrees", "agrees", "agrees", "agrees"])]],
  ])("no consensus/majority row → starts with the canonical no-consensus text (%s)", (_name, rows) => {
    const text = statement(rows as AlignedClaim[]);
    expect(text.startsWith(`${NO_CONSENSUS_IDENTIFIED} Of 1 scored claim across 5 dispatched models: `)).toBe(true);
    expect(text).not.toMatch(/consensus on|majority agreement on/);
  });

  it("an unknown status is counted as unrecognised, never as agreement", () => {
    expect(statement([row("consensus", ["agrees", "agrees", "agrees"]), row("near_consensus", ["agrees"])])).toBe(
      "Of 2 scored claims across 5 dispatched models: consensus on 1; an unrecognised status on 1 (not counted as agreement)."
    );
  });

  it("a run with no scored claims has no statement", () => {
    expect(statement([])).toBe("");
  });

  it("singular grammar", () => {
    expect(statement([row("consensus", ["agrees"])], 1)).toBe("Of 1 scored claim across 1 dispatched model: consensus on 1.");
  });
});
