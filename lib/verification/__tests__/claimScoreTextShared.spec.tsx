/**
 * R5 (review record 16, section F) — the shared claim score text renderer, the Personal history suffix's live / cached
 * payload path (reviewer mutant X11 survived: nothing exercised it), the fail-closed rule for a cached payload that
 * carries no rows, and conflict text naming the EXECUTING models instead of slot ids (MINOR-4).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildCase, memoFor, MODES, textNodes } from "./claimStatementInventory.harness";
import ClaimVerificationResultView, { buildClaimVerdictClipboardText } from "@/components/verification/ClaimVerificationResultView";
import * as Presentation from "@/lib/verification/claimConsensusPresentation";
import { claimQueuePresentation } from "@/lib/verification/claimQueuePresentation";

const mode = (name: string) => MODES.find((m) => m.name === name)!;
const QUALIFIER = "computed over panel slot responses, not independent corroboration";
// Read lazily so a missing export fails the test that needs it (failing-first), not the whole file.
const P = Presentation as unknown as Record<string, any>;

describe("claimScoreText — the one claim score text renderer (R5)", () => {
  const fmt = (n: number) => `${Math.round(n)}/100`;
  it("withheld reason replaces the number; the qualifier is added only for the slot-response basis", () => {
    expect(P.claimScoreText({ consensusScore: 92, consensusWithheld: "insufficient_independent_models" }, fmt, "—")).toBe("No consensus score (fewer than two independent models)");
    expect(P.claimScoreText({ consensusScore: 92, consensusWithheld: "independence_unverified" }, fmt, "—")).toBe("Consensus score withheld (model independence not recorded)");
    expect(P.claimScoreText({ consensusScore: 92, consensusBasis: "slot_responses" }, fmt, "—")).toBe(`92/100 (${QUALIFIER})`);
    expect(P.claimScoreText({ consensusScore: 92 }, fmt, "—")).toBe("92/100");
    expect(P.claimScoreText({ consensusScore: 92, consensusBasis: "something_else" }, fmt, "—")).toBe("92/100");
    expect(P.claimScoreText({ consensusScore: null }, fmt, "—")).toBe("—");
    expect(P.claimScoreText({}, fmt, "No consensus score")).toBe("No consensus score");
  });
});

describe("Personal history suffix — live / cached payload path (R5, X11)", () => {
  const collapsed = buildCase(["A", "A", "A", "A", "I"], mode("ds:1-4"));
  const own = buildCase(["A", "A", "A", "A", "I"], mode("own"));

  it("a live / cached item with no server basis derives it from its payload rows", () => {
    expect(Presentation.claimHistoryConsensusSuffix({ consensusScore: 70, modelIndependence: "independent", payload: collapsed.payload })).toBe(` · 70 consensus (${QUALIFIER})`);
    expect(Presentation.claimHistoryConsensusSuffix({ consensusScore: 70, modelIndependence: "independent", payload: own.payload })).toBe(" · 70 consensus");
  });

  it("a cached payload that carries no rows proves no basis → withheld as unverified (fail closed), never a bare score", () => {
    const rowless = { ...collapsed.payload, modelEvidence: undefined } as unknown as typeof collapsed.payload;
    expect(Presentation.claimHistoryConsensusSuffix({ consensusScore: 70, modelIndependence: "independent", payload: rowless })).toBe(" · Consensus score withheld (model independence not recorded)");
    // The server's basis, when the row carries one, still decides.
    expect(Presentation.claimHistoryConsensusSuffix({ consensusScore: 70, modelIndependence: "independent", consensusBasis: "slot_responses", payload: rowless })).toBe(` · 70 consensus (${QUALIFIER})`);
  });
});

describe("conflict text names the executing models, not slot ids (R5 MINOR-4)", () => {
  // Partially accurate (supports) vs inaccurate with disjoint incorrect parts: a conflict per slot pair against Perplexity.
  const c = buildCase(["P", "P", "P", "P", "I"], mode("ds:1-4"));
  const NAMED = "Conflicting assessments: DeepSeek (substituting ChatGPT, Claude, Gemini, Grok) vs Perplexity";

  it("copied verdict", () => {
    const clip = buildClaimVerdictClipboardText(c.payload);
    expect(clip.split("\n")).toContain(`• ${NAMED}`);
    expect(clip).not.toContain("(chatgpt) vs (perplexity)");
  });

  it("memo", () => {
    const memo = memoFor(c.payload);
    expect(memo.split("\n")).toContain(`- ${NAMED}`);
    expect(memo).not.toContain("(chatgpt) vs (perplexity)");
  });

  it("result view", () => {
    const nodes = textNodes(renderToStaticMarkup(createElement(ClaimVerificationResultView, { data: c.payload } as never)));
    expect(nodes).toContain(NAMED);
    expect(nodes.join("\n")).not.toContain("(chatgpt) vs (perplexity)");
  });

  it("governance queue", () => {
    const q = claimQueuePresentation(c.doc as unknown as Record<string, unknown>, (v) => v, c.payload.whereModelsDisagree);
    expect(q.lines?.disagreements).toEqual([NAMED]);
  });

  it("control: own models keep the established slot-id text everywhere", () => {
    const o = buildCase(["P", "P", "P", "P", "I"], mode("own"));
    expect(buildClaimVerdictClipboardText(o.payload)).toContain("• Conflicting assessments: (chatgpt) vs (perplexity) [ChatGPT, Perplexity]");
    expect(memoFor(o.payload)).toContain("- Conflicting assessments: (chatgpt) vs (perplexity) [ChatGPT, Perplexity]");
  });
});
