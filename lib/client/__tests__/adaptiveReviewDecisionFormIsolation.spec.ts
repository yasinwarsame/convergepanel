/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — decision-form-own
 * isolation guarantees, proven as honest source-level structural tests
 * (no DOM/RTL environment exists in this repo — `jest.config.ts` uses
 * `testEnvironment: "node"`). Covers what
 * `readOnlyIsolation.spec.ts` (rescoped to the queue-only surface in this
 * same step) intentionally no longer checks for the detail page: that the
 * ONE place in the entire client bundle that calls the decision-mutation
 * route does so exactly once, with no automatic retry.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "../../..");

function allSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      allSourceFiles(full, acc);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

function filesReferencingDecisionRoute(): string[] {
  const candidates = [
    ...allSourceFiles(join(ROOT, "lib")),
    ...allSourceFiles(join(ROOT, "components")),
    ...allSourceFiles(join(ROOT, "app")),
  ];
  // Matches only the literal CODE pattern of an actual fetch call
  // (`${...}/decision\``) — not a prose mention of the route path in a doc
  // comment, which several Part D/E1/E2 files legitimately contain.
  const callSitePattern = /\$\{[^}]*\}\/decision`/;
  return candidates.filter((f) => {
    if (f.endsWith(join("adaptive-runs", "[runId]", "decision", "route.ts"))) return false; // the server route itself
    const contents = readFileSync(f, "utf8");
    return callSitePattern.test(contents);
  });
}

describe("Adaptive review decision route — client call-site isolation", () => {
  it("the decision-mutation route is referenced from exactly one client file", () => {
    const files = filesReferencingDecisionRoute();
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("adaptiveReviewSubmission.ts");
  });

  it("the submission service never contains a retry loop (no setTimeout/setInterval/recursive resubmission)", () => {
    const contents = readFileSync(join(ROOT, "lib/client/adaptiveReviewSubmission.ts"), "utf8");
    expect(contents).not.toMatch(/setTimeout/);
    expect(contents).not.toMatch(/setInterval/);
    expect(contents).not.toMatch(/retry/i);
  });

  it("the decision form never auto-submits on mount or on status change (submission only occurs inside a form submit handler)", () => {
    const contents = readFileSync(join(ROOT, "components/teamGovernance/AdaptiveReviewDecisionForm.tsx"), "utf8");
    // The only call to submitAdaptiveReviewDecision must be inside handleSubmit, never inside a useEffect.
    const useEffectBlocks = contents.match(/useEffect\(([\s\S]*?)\},\s*\[/g) ?? [];
    for (const block of useEffectBlocks) {
      expect(block).not.toContain("submitAdaptiveReviewDecision");
    }
  });

  it("draft form state is never written to localStorage, sessionStorage, cookies, or the URL", () => {
    const formSource = readFileSync(join(ROOT, "components/teamGovernance/AdaptiveReviewDecisionForm.tsx"), "utf8");
    const editorSource = readFileSync(join(ROOT, "components/teamGovernance/AdaptiveReviewConditionsEditor.tsx"), "utf8");
    const combined = formSource + editorSource;
    // Checks for actual API USAGE, not the bare word — the editor's own
    // doc comment explains it deliberately avoids these, which would
    // otherwise (harmlessly) trip a naive substring check.
    expect(combined).not.toMatch(/localStorage\.(setItem|getItem)/);
    expect(combined).not.toMatch(/sessionStorage\.(setItem|getItem)/);
    expect(combined).not.toMatch(/document\.cookie\s*=/);
    expect(combined).not.toMatch(/router\.(push|replace)/);
  });

  it("the decision form never fetches or references model/classifier/synthesis/quota/token/legacy-decision endpoints", () => {
    const contents = readFileSync(join(ROOT, "components/teamGovernance/AdaptiveReviewDecisionForm.tsx"), "utf8");
    for (const forbidden of ["/api/run-panel", "/api/synthesize-panel", "/api/user/usage", "/api/teams/runs/", "quota", "tokenFinalization"]) {
      expect(contents).not.toContain(forbidden);
    }
  });
});
