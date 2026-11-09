/**
 * C-a share / copy rows: D06 (model-written legacy blocks in text, O3 (a)) and D03 (X unmarked: a budgeted build whose
 * qualifier and brand are never cut; the fallback qualified). Real builders (lib/adaptiveSchema/shareBuilders.ts).
 * Negatives: an IND run (or no identity) builds byte-identically to the builder without the identity argument.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { buildAdaptiveLinkedInPost, buildAdaptiveSynthesisMarkdown, buildAdaptiveXPost } from "@/lib/adaptiveSchema/shareBuilders";
import { modelWrittenBlockLabel, modelWrittenShortLabel, runExecutionIdentity } from "@/lib/panel/executionIdentity";
import { DIGIT_NEXT_TO_INDEPENDENT, ok, rowsOf, sub, type SetName } from "@/lib/panel/__tests__/executionIdentityScenarios";

const records = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const legacy = (name: string) => {
  const { presentation: _p, ...rest } = records[name].synthesisReport;
  return rest;
};
const Q = "Does raising the minimum wage reduce employment?";
const LONG_Q = `${"Does raising the minimum wage in a mid-sized regional economy reduce total employment, ".repeat(6)}?`;
const PRE62A = ["chatgpt", "claude", "grok", "perplexity", "gemini"].map((m) => ok(m, null));

describe("D06: one label per legacy model-written block group in text; IND unchanged", () => {
  it.each(["S1", "S2", "S2b", "S7"] as SetName[])("%s markdown: one italic label per group", (name) => {
    const id = runExecutionIdentity(rowsOf(name));
    const md = buildAdaptiveSynthesisMarkdown(Q, legacy("generic-mixed"), undefined, null, id);
    const label = `_${modelWrittenBlockLabel(id)}_`;
    expect(md.split(label).length - 1).toBe(5); // Unified Answer, Executive Summary, agree, disagree, Certainty
    expect(md).toContain("Source: convergepanel.com");
  });
  it("UV (pre-6.2a): the UV form, no count", () => {
    const md = buildAdaptiveSynthesisMarkdown(Q, legacy("generic-mixed"), undefined, null, runExecutionIdentity(PRE62A));
    expect(md).toContain("are not verified: model independence unverified.");
    expect(md).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
  });
  it.each(["S4", "S5", "S4f", "S8b"] as SetName[])("%s: markdown / LinkedIn / X byte-identical to the build without identity", (name) => {
    const id = runExecutionIdentity(rowsOf(name));
    const r = legacy("generic-mixed");
    expect(buildAdaptiveSynthesisMarkdown(Q, r, undefined, null, id)).toBe(buildAdaptiveSynthesisMarkdown(Q, r, undefined, null));
    expect(buildAdaptiveLinkedInPost(Q, r, undefined, id)).toBe(buildAdaptiveLinkedInPost(Q, r));
    expect(buildAdaptiveXPost(Q, r, undefined, id)).toBe(buildAdaptiveXPost(Q, r));
  });
  it("LinkedIn (S1): one label before the model-written lines", () => {
    const id = runExecutionIdentity(rowsOf("S1"));
    const post = buildAdaptiveLinkedInPost(Q, legacy("generic-mixed"), undefined, id);
    expect(post.split(modelWrittenBlockLabel(id)).length - 1).toBe(1);
  });
  it("a presented (Order 4) report is not relabelled (its blocks carry their own attribution)", () => {
    const id = runExecutionIdentity(rowsOf("S1"));
    const r = records["generic-mixed"].synthesisReport;
    expect(buildAdaptiveSynthesisMarkdown(Q, r, undefined, null, id)).toBe(buildAdaptiveSynthesisMarkdown(Q, r, undefined, null));
  });
});

describe("D03: X unmarked — budgeted; qualifier and brand never cut; fallback qualified", () => {
  const xs: Array<[string, unknown[]]> = [
    ["S1", rowsOf("S1")],
    ["S2", rowsOf("S2")],
    ["S3 (pre-6.2a)", PRE62A],
  ];
  it.each(xs)("%s: short and long question both end with the qualifier and the brand, within 280", (_n, rows) => {
    const id = runExecutionIdentity(rows as any);
    for (const question of [Q, LONG_Q]) {
      for (const rec of ["generic-mixed", "generic-splits"]) {
        const post = buildAdaptiveXPost(question, legacy(rec), undefined, id);
        expect(post.length).toBeLessThanOrEqual(280);
        expect(post.endsWith(`${modelWrittenShortLabel(id)}\n\nvia ConvergePanel`)).toBe(true);
        expect(post).not.toMatch(/^Models split on:/m);
      }
    }
  });
  it("FC fallback: 'Recorded difference', never 'Models split on'", () => {
    const post = buildAdaptiveXPost(Q, { ...legacy("generic-splits"), presentation: undefined }, undefined, runExecutionIdentity(rowsOf("S1")));
    if (legacy("generic-splits").disagreements.length > 0) expect(post).toMatch(/^Recorded difference: /m);
  });
  it("IND long question: the brand is never cut either (the budgeted build)", () => {
    const post = buildAdaptiveXPost(LONG_Q, legacy("generic-splits"), undefined, runExecutionIdentity(rowsOf("S4")));
    expect(post.length).toBeLessThanOrEqual(280);
    expect(post.endsWith("via ConvergePanel")).toBe(true);
  });
  it("S8d (two different substitute providers) is IND: no qualifier", () => {
    expect(buildAdaptiveXPost(Q, legacy("generic-mixed"), undefined, runExecutionIdentity(rowsOf("S8d")))).toBe(buildAdaptiveXPost(Q, legacy("generic-mixed")));
    expect(sub("chatgpt", "mistral").provider).toBe("mistral");
  });
});
