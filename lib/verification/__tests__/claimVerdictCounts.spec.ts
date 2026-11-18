/**
 * PR-1 (evidence doc 14) — unit tests for the parser rule, the per-model verdict counts and the verdict-aware digest.
 * Pure functions, synthetic rows only.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { parsedModelVerificationFromObject, tryParseVerificationJson } from "@/lib/verification/parseVerificationJson";
import {
  buildClaimModelEvidence,
  MALFORMED_VERDICT_PART,
  MISSING_VERDICT_SUMMARY,
  UNRECOGNIZED_VERDICT_SUMMARY,
} from "@/lib/verification/buildClaimModelEvidence";
import {
  claimPayloadSlotTally,
  claimProviderSides,
  claimSlotTally,
  splitClaimDisagreementsByIdentity,
  claimSlotTallyNote,
  claimVerdictShape,
  countClaimModelVerdicts,
  countClaimModelVerdictsFromAuditBundle,
  formatClaimVerdictCounts,
  hasSplitVerdicts,
  isDisputedWithoutSupport,
  parseClaimModelVerdictCounts,
} from "@/lib/verification/claimVerdictCounts";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";
import type { ModelId, ModelResult } from "@/lib/types";

const ok = (modelId: string, body: Record<string, unknown>): ModelResult =>
  ({ modelId: modelId as ModelId, status: "ok", rawText: JSON.stringify(body), latencyMs: 1 }) as unknown as ModelResult;

describe("parser: formatting-only normalisation of the existing vocabulary", () => {
  it.each([
    ["ACCURATE", "accurate"],
    ["  inaccurate\n", "inaccurate"],
    ["Partially-Accurate", "partially_accurate"],
    ["partially  accurate", "partially_accurate"],
    ["partially__accurate", "partially_accurate"],
    ["Partially_Accurate", "partially_accurate"],
    ["partially - accurate", "partially_accurate"],
    ["Unverifiable", "unverifiable"],
    ["partial", "partially_accurate"],
    [" Partial ", "partially_accurate"],
  ])("%j -> %s", (raw, expected) => {
    const p = parsedModelVerificationFromObject({ verdict: raw });
    expect(p.verdict).toBe(expected);
    expect(p.verdictIssue).toBeNull();
  });

  it.each([["true"], ["false"], ["correct"], ["mostly accurate"], ["partly accurate"], ["accurate."], ["accur"], ["n/a"], ["refuted"]])(
    "no semantic alias: %j is unrecognized",
    (raw) => {
      const p = parsedModelVerificationFromObject({ verdict: raw });
      expect(p.verdict).toBeNull();
      expect(p.verdictIssue).toBe("unrecognized_verdict");
    }
  );

  it.each([[undefined], [null], [""], ["   "]])("%j is a missing verdict", (raw) => {
    const p = parsedModelVerificationFromObject(raw === undefined ? {} : { verdict: raw });
    expect(p.verdict).toBeNull();
    expect(p.verdictIssue).toBe("missing_verdict");
  });

  it.each([[42], [true], [{ v: "accurate" }], [["accurate"]]])("a non-string %j is unrecognized", (raw) => {
    expect(parsedModelVerificationFromObject({ verdict: raw }).verdictIssue).toBe("unrecognized_verdict");
  });

  it("tryParseVerificationJson: a response without a recognised verdict is not ok; a valid one is", () => {
    expect(tryParseVerificationJson(JSON.stringify({ verdict: "mostly true" })).ok).toBe(false);
    expect(tryParseVerificationJson(JSON.stringify({ summary: "x" })).ok).toBe(false);
    const good = tryParseVerificationJson(JSON.stringify({ verdict: "Inaccurate" }));
    expect(good.ok && good.data.verdict).toBe("inaccurate");
  });
});

describe("buildClaimModelEvidence: malformed verdicts are the existing parse_error row", () => {
  it("unrecognized verdict -> parse_error with its own summary; no parts, no provider, no raw value stored", () => {
    const [row] = buildClaimModelEvidence([{ ...ok("chatgpt", { verdict: "mostly true", summary: "the claim is mostly true", correctParts: ["x"] }), provider: "openai" } as ModelResult]);
    expect(row).toEqual({
      modelId: "chatgpt",
      status: "parse_error",
      verdict: "parse_error",
      confidence: "low",
      summary: UNRECOGNIZED_VERDICT_SUMMARY,
      correctParts: [],
      incorrectParts: [],
      unverifiableParts: [MALFORMED_VERDICT_PART],
    });
    expect(JSON.stringify(row)).not.toContain("mostly true");
  });

  it("missing verdict -> parse_error with the missing-verdict summary", () => {
    const [row] = buildClaimModelEvidence([ok("claude", { summary: "s" })]);
    expect(row.status).toBe("parse_error");
    expect(row.summary).toBe(MISSING_VERDICT_SUMMARY);
  });

  it("[CONTROL] a formatting variant stays a usable ok row with the canonical verdict and its provider", () => {
    const [row] = buildClaimModelEvidence([{ ...ok("claude", { verdict: "Partially-Accurate", confidence: "high" }), provider: "anthropic" } as ModelResult]);
    expect(row.status).toBe("ok");
    expect(row.verdict).toBe("partially_accurate");
    expect(row.provider).toBe("anthropic");
  });

  it("[CONTROL] non-JSON output is still the original parse_error row", () => {
    const [row] = buildClaimModelEvidence([{ modelId: "grok" as ModelId, status: "ok", rawText: "I cannot answer", latencyMs: 1 } as unknown as ModelResult]);
    expect(row.status).toBe("parse_error");
    expect(row.summary).toBe("Model returned invalid JSON; could not parse verification result.");
  });
});

describe("per-model verdict counts", () => {
  const bundle = (perModel: unknown[]) => ({ version: "1", kind: "claim_verification", perModel });
  const pm = (pipelineStatus: string, verdictLabel: string | null) => ({ modelId: "m", pipelineStatus, verdictLabel, confidence: null, summaryLength: 1, counts: { correct: 0, incorrect: 0, unverifiable: 0 } });

  it("counts only usable rows from the audit bundle; parse_error / failed are not answers", () => {
    expect(countClaimModelVerdictsFromAuditBundle(bundle([pm("ok", "accurate"), pm("ok", "inaccurate"), pm("parse_error", null), pm("failed", null), pm("ok", "unverifiable")]))).toEqual({
      accurate: 1,
      partially_accurate: 0,
      inaccurate: 1,
      unverifiable: 1,
      usable: 3,
    });
  });

  it.each([
    ["no bundle", undefined],
    ["no perModel", { version: "1" }],
    ["perModel not an array", bundle("x" as never)],
    ["unknown pipeline status", bundle([pm("weird", "accurate")])],
    ["ok row with unknown verdict", bundle([pm("ok", "mostly")])],
    ["ok row with null verdict", bundle([pm("ok", null)])],
    ["non-object row", bundle([1])],
  ])("uncountable (%s) -> null, never a guessed count", (_l, b) => {
    expect(countClaimModelVerdictsFromAuditBundle(b)).toBeNull();
  });

  it("a payload is counted from its rows cross-checked with its bundle, never from aggregateSummary (which folds parse_error into unverifiable)", () => {
    const rows = [{ status: "ok", verdict: "inaccurate" }, { status: "ok", verdict: "inaccurate" }, { status: "parse_error", verdict: "parse_error" }];
    const payload = {
      auditBundle: bundle([pm("ok", "inaccurate"), pm("ok", "inaccurate"), pm("parse_error", null)]),
      modelEvidence: rows,
      aggregateSummary: { totalModels: 3, modelsAgreeAccurate: 0, modelsAgreeInaccurate: 2, modelsPartial: 0, modelsUnverifiable: 1 },
    };
    expect(claimPayloadSlotTally(payload)?.verdicts).toEqual({ accurate: 0, partially_accurate: 0, inaccurate: 2, unverifiable: 0, usable: 2 });
    expect(claimPayloadSlotTally(payload)?.malformed).toBe(1);
    // An uncountable bundle does not block the rows; a bundle that DISAGREES with the rows states nothing.
    expect(claimPayloadSlotTally({ ...payload, auditBundle: undefined })?.verdicts.inaccurate).toBe(2);
    expect(claimPayloadSlotTally({ ...payload, modelEvidence: [{ status: "ok", verdict: "accurate" }] })).toBeNull();
  });

  it("slot tally: failed, malformed, unverifiable and usable stay distinct; substitution and providers as recorded", () => {
    const t = claimSlotTally([
      { status: "ok", verdict: "inaccurate", provider: "deepseek", substituted: true },
      { status: "ok", verdict: "unverifiable", provider: "deepseek", substituted: true },
      { status: "ok", verdict: "inaccurate", provider: "xai" },
      { status: "failed", verdict: "failed" },
      { status: "parse_error", verdict: "parse_error" },
    ]);
    expect(t).toEqual({ slots: 5, usable: 3, failed: 1, malformed: 1, substitutedUsable: 2, providers: 2, verdicts: { accurate: 0, partially_accurate: 0, inaccurate: 2, unverifiable: 1, usable: 3 } });
    expect(claimSlotTallyNote(t!)).toBe("3 of 5 slots answered; 1 failed; 1 malformed (no recognized verdict); 2 answered by a substitute model; 2 distinct executing providers");
    // Historic rows record no provider: providers unknown (null), never guessed.
    expect(claimSlotTally([{ status: "ok", verdict: "accurate" }, { status: "ok", verdict: "accurate", provider: "openai" }])?.providers).toBeNull();
    expect(claimSlotTally([{ status: "weird" }])).toBeNull();
  });

  it("R3: non-canonical provider ids never count as identities (providers unknown → null)", () => {
    for (const bad of ["unknown", "acme", "", "  ", "OpenAI-ish"]) {
      expect(claimSlotTally([{ status: "ok", verdict: "accurate", provider: bad }, { status: "ok", verdict: "accurate", provider: "openai" }])?.providers).toBeNull();
    }
    // Case / whitespace variants of a registered token are that provider (canonicalProvider), not a second one.
    expect(claimSlotTally([{ status: "ok", verdict: "accurate", provider: " OpenAI " }, { status: "ok", verdict: "accurate", provider: "openai" }])?.providers).toBe(1);
  });

  it("R3: provider sides — opposite sides need two DIFFERENT identified providers; unknown ids make identity unreliable", () => {
    const ds = (verdict: string, id: string) => ({ modelId: id, status: "ok", verdict, provider: "deepseek", substituted: true });
    const own = (verdict: string, id: string, provider: string) => ({ modelId: id, status: "ok", verdict, provider });
    const one = claimProviderSides([ds("accurate", "chatgpt"), ds("inaccurate", "claude"), own("unverifiable", "gemini", "google")]);
    expect([one.reliable, one.crossModelDisagreement, one.providers, one.consistent]).toEqual([true, false, 2, false]);
    const two = claimProviderSides([own("accurate", "chatgpt", "openai"), own("inaccurate", "claude", "anthropic")]);
    expect(two.crossModelDisagreement).toBe(true);
    const unknown = claimProviderSides([own("accurate", "chatgpt", "unknown"), own("inaccurate", "claude", "anthropic")]);
    expect([unknown.reliable, unknown.crossModelDisagreement, unknown.supportAgreement]).toEqual([false, false, false]);
    const partialOne = claimProviderSides([ds("partially_accurate", "chatgpt"), ds("partially_accurate", "claude"), own("unverifiable", "gemini", "google")]);
    expect(partialOne.supportAgreement).toBe(false);
    expect(claimProviderSides([own("partially_accurate", "chatgpt", "openai"), own("accurate", "claude", "anthropic")]).supportAgreement).toBe(true);
    // An own slot recording another slot's provider is the same identified model.
    expect(claimProviderSides([own("accurate", "chatgpt", "anthropic"), own("inaccurate", "claude", "anthropic")]).crossModelDisagreement).toBe(false);
  });

  it("R3: digest pairs are split by identified provider", () => {
    const sides = claimProviderSides([
      { modelId: "chatgpt", status: "ok", verdict: "accurate", provider: "deepseek", substituted: true },
      { modelId: "claude", status: "ok", verdict: "inaccurate", provider: "deepseek", substituted: true },
      { modelId: "grok", status: "ok", verdict: "inaccurate", provider: "xai" },
    ]);
    const pts = [{ point: "a", models: ["chatgpt", "claude"] }, { point: "b", models: ["chatgpt", "grok"] }, { point: "c", models: ["chatgpt", "gemini"] }];
    expect(splitClaimDisagreementsByIdentity(pts, sides)).toEqual({ betweenModels: [pts[1]], betweenSlots: [pts[0], pts[2]] });
  });

  it("row counting skips non-ok rows and rejects an ok row outside the vocabulary", () => {
    expect(countClaimModelVerdicts([{ status: "failed", verdict: "failed" }, { verdict: "accurate" }, { status: "ok", verdict: "partially_accurate" }])).toEqual({ accurate: 0, partially_accurate: 1, inaccurate: 0, unverifiable: 0, usable: 1 });
    expect(countClaimModelVerdicts([{ status: "ok", verdict: "parse_error" }])).toBeNull();
    expect(countClaimModelVerdicts([null])).toBeNull();
  });

  const c = (a: number, p: number, i: number, u: number) => ({ accurate: a, partially_accurate: p, inaccurate: i, unverifiable: u, usable: a + p + i + u });

  it.each([
    [c(0, 0, 3, 0), "unanimous", true, false],
    [c(0, 0, 3, 1), "no_support", true, false],
    [c(0, 0, 2, 1), "no_support", true, false],
    [c(2, 1, 2, 0), "split", false, true],
    [c(1, 0, 3, 0), "split", false, true],
    [c(0, 2, 3, 0), "split", false, true],
    [c(4, 0, 1, 0), "split", false, true],
    [c(5, 0, 0, 0), "unanimous", false, false],
    [c(2, 0, 0, 3), "other", false, false],
    [c(0, 0, 0, 0), "other", false, false],
  ])("%j -> shape %s; disputed-without-support %s; split %s", (counts, shape, noSupport, split) => {
    expect(claimVerdictShape(counts)).toBe(shape);
    expect(isDisputedWithoutSupport("disputed", counts)).toBe(noSupport);
    expect(hasSplitVerdicts(counts)).toBe(split);
  });

  it("only a stored 'disputed' label is ever re-described", () => {
    for (const v of ["confirmed", "partially_true", "unverifiable", undefined]) expect(isDisputedWithoutSupport(v, c(0, 0, 3, 0))).toBe(false);
    expect(isDisputedWithoutSupport("disputed", null)).toBe(false);
  });

  it("formats non-zero counts in a fixed order", () => {
    expect(formatClaimVerdictCounts(c(4, 0, 1, 0))).toBe("4 accurate, 1 inaccurate");
    expect(formatClaimVerdictCounts(c(0, 2, 3, 1))).toBe("2 partially accurate, 3 inaccurate, 1 unverifiable");
  });

  it("wire parse: the five keys valid (non-negative integers, usable = sum); extra keys ignored (forward-compatible)", () => {
    expect(parseClaimModelVerdictCounts(c(4, 0, 1, 0))).toEqual(c(4, 0, 1, 0));
    expect(parseClaimModelVerdictCounts({ ...c(4, 0, 1, 0), usable: 4 })).toBeNull();
    expect(parseClaimModelVerdictCounts({ ...c(4, 0, 1, 0), failed: 2, malformed: 1 })).toEqual(c(4, 0, 1, 0));
    expect(parseClaimModelVerdictCounts({ ...c(4, 0, 1, 0), accurate: -1, usable: 0 })).toBeNull();
    expect(parseClaimModelVerdictCounts({ ...c(1, 0, 0, 0), accurate: 1.5, usable: 1.5 })).toBeNull();
    expect(parseClaimModelVerdictCounts({ accurate: 1, partially_accurate: 0, inaccurate: 0, usable: 1 })).toBeNull();
    expect(parseClaimModelVerdictCounts("x")).toBeNull();
  });
});

describe("digest: conflicts follow the models' verdicts", () => {
  const long1 = "The completion year stated in the claim is wrong by twelve years";
  const long2 = "Construction concluded during March of eighteen eighty-nine instead";

  it("two partially-accurate models flagging different details are not in conflict (same side)", () => {
    const d = buildAgreementDisagreementDigest([
      { modelId: "chatgpt", verdict: "partially_accurate", correctParts: [], incorrectParts: [long1] },
      { modelId: "claude", verdict: "partially_accurate", correctParts: [], incorrectParts: [long2] },
    ]);
    expect(d.whereModelsDisagree).toEqual([]);
  });

  it("the legacy low-overlap rule still fires for a pair on opposite sides (supports vs inaccurate)", () => {
    const d = buildAgreementDisagreementDigest([
      { modelId: "chatgpt", verdict: "partially_accurate", correctParts: [], incorrectParts: [long1] },
      { modelId: "claude", verdict: "inaccurate", correctParts: [], incorrectParts: [long2] },
    ]);
    expect(d.whereModelsDisagree).toEqual([{ point: "Conflicting assessments: (chatgpt) vs (claude)", models: ["chatgpt", "claude"] }]);
  });

  it("rows without a usable verdict (absent, unverifiable, parse_error) never form a legacy conflict", () => {
    for (const v of [undefined, "unverifiable", "parse_error", "failed"]) {
      const d = buildAgreementDisagreementDigest([
        { modelId: "chatgpt", verdict: v, correctParts: [], incorrectParts: [long1] },
        { modelId: "claude", verdict: "inaccurate", correctParts: [], incorrectParts: [long2] },
      ]);
      expect(d.whereModelsDisagree).toEqual([]);
    }
  });

  it("a correct-vs-incorrect clash is one entry per pair, in input order, even when found both ways", () => {
    const x = "The tower stands on the Champ de Mars in Paris";
    const y = "The tower was designed by Gustave Eiffel's engineering company";
    const d = buildAgreementDisagreementDigest([
      { modelId: "grok", verdict: "inaccurate", correctParts: [y], incorrectParts: [x] },
      { modelId: "gemini", verdict: "accurate", correctParts: [x], incorrectParts: [y] },
    ]);
    expect(d.whereModelsDisagree).toEqual([{ point: "Conflicting assessments: (grok) vs (gemini)", models: ["grok", "gemini"] }]);
  });

  it("a part-level clash is reported even between two models with the same overall verdict", () => {
    const x = "The tower stands on the Champ de Mars in Paris";
    const d = buildAgreementDisagreementDigest([
      { modelId: "chatgpt", verdict: "inaccurate", correctParts: [x], incorrectParts: [] },
      { modelId: "claude", verdict: "inaccurate", correctParts: [], incorrectParts: [x] },
    ]);
    expect(d.whereModelsDisagree.map((e) => e.models)).toEqual([["chatgpt", "claude"]]);
  });
});
