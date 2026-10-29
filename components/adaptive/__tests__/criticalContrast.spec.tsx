/**
 * Order 6 critical-contrast slice — the four critical-flow text elements meet WCAG 1.4.3 (4.5:1 for normal text),
 * and the slice changed only their colour classes.
 *
 * Ratios are computed from the real colour sources (Tailwind's palette and this repo's cp tokens in tailwind.config.ts)
 * against the backgrounds measured in the isolated accessibility run (white card surfaces: #ffffff).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";
import TeamResearchReviewSummary from "@/components/workspace/projects/TeamResearchReviewSummary";
import tailwindColors from "tailwindcss/colors";
import { CRITICAL_CONTRAST_CLASS_CHANGES, undoCriticalContrastClasses } from "./criticalContrastSlice";

const palette = tailwindColors as unknown as Record<string, Record<string, string>>;
const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const cpToken = (name: string) => {
  const m = src("tailwind.config.ts").match(new RegExp(`\\b${name}:\\s*'(#[0-9A-Fa-f]{6})'`));
  if (!m) throw new Error(`cp token ${name} not found`);
  return m[1];
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg: string, bg: string) => { const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
const WHITE = "#ffffff";

describe("contrast of the corrected critical-flow text (WCAG 1.4.3, normal text ≥ 4.5:1)", () => {
  it.each([
    ["no-access / error message (text-red-700)", palette.red["700"], 6.4],
    ["model-count disclosure (text-slate-600)", palette.slate["600"], 7.5],
    ["Conditions / Decision receipt labels (text-cp-muted)", cpToken("muted"), 5.7],
  ])("%s", (_label, fg, floor) => {
    expect(ratio(fg, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(fg, WHITE)).toBeGreaterThanOrEqual(floor); // margin above the minimum
  });

  it("the replaced colours failed (self-check of the ratio function against the measured values)", () => {
    expect(ratio(palette.red["400"], WHITE)).toBeCloseTo(2.77, 1);
    expect(ratio(palette.slate["400"], WHITE)).toBeCloseTo(2.56, 1);
    expect(ratio(cpToken("faint"), WHITE)).toBeCloseTo(2.79, 1);
  });
});

describe("the slice changes exactly these class values in source", () => {
  it.each([
    ["components/teamGovernance/ReviewErrorState.tsx", "text-sm font-medium text-red-700", "text-red-400", 1],
    ["components/adaptive/DecisionSupportView.tsx", "mt-1 text-xs text-slate-600", "text-slate-400\">{recommendationCounts}", 1],
    ["components/workspace/projects/TeamResearchReviewSummary.tsx", "text-xs font-medium uppercase tracking-wide text-cp-muted", "text-cp-faint", 2],
  ])("%s", (file, now, gone, count) => {
    const s = src(file);
    expect(s.split(`"${now}"`).length - 1).toBe(count);
    expect(s).not.toContain(gone);
  });

  it("the reverse map covers exactly three class values, each changing one colour utility", () => {
    expect(CRITICAL_CONTRAST_CLASS_CHANGES).toHaveLength(3);
    for (const [now, before] of CRITICAL_CONTRAST_CLASS_CHANGES) {
      const a = now.split(" "), b = before.split(" ");
      expect(a.length).toBe(b.length);
      expect(a.filter((t, i) => t !== b[i])).toHaveLength(1);
    }
  });
});

describe("rendered markup carries the corrected classes, and wording is unchanged", () => {
  it("ReviewErrorState: same message text, corrected colour; reversal restores the old markup", () => {
    const html = renderToStaticMarkup(createElement(ReviewErrorState, { message: "You don't have access to this review." }));
    expect(html).toContain('class="text-sm font-medium text-red-700"');
    expect(html).toContain("You don&#x27;t have access to this review.");
    const undone = undoCriticalContrastClasses(html);
    expect(undone.reversed).toBe(1);
    expect(undone.markup).toContain('class="text-sm font-medium text-red-400"');
  });

  it("TeamResearchReviewSummary: both labels use text-cp-muted with unchanged wording", () => {
    const html = renderToStaticMarkup(createElement(TeamResearchReviewSummary, {
      review: { humanReviewStatus: "approved_with_conditions", conditions: ["COND-1"], decisionReceipt: { conclusion: "Conclusion.", sourceBacked: false, humanReviewNeeded: false } } as never,
      schemaId: "contested_empirical",
    }));
    expect(html.split('class="text-xs font-medium uppercase tracking-wide text-cp-muted"').length - 1).toBe(2);
    expect(html).toContain(">Conditions</p>");
    expect(html).toContain(">Decision receipt</p>");
    expect(html).not.toContain("text-cp-faint");
    expect(undoCriticalContrastClasses(html).reversed).toBe(2);
  });
});
