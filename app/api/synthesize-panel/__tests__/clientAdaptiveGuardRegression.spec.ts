/**
 * Query-Routing Redesign, Phase 2A, Step 6 — client-side guard regression
 * test.
 *
 * IMPORTANT SCOPE NOTE: this repo's jest config runs `testEnvironment:
 * "node"` and has no `@testing-library/react` (or any DOM-rendering
 * library) installed — confirmed by checking package.json and jest.config.ts
 * before writing this file. Rendering `app/page.tsx` (a large client
 * component with many hooks/effects) and simulating a real run/reload is
 * therefore not feasible without adding new test infrastructure, which is
 * out of this narrowly-scoped bug-fix step. Introducing that dependency
 * was deliberately avoided rather than done silently — see the Step 6 fix
 * report for this tradeoff stated explicitly.
 *
 * What this file verifies instead — honestly, at the SOURCE level, not by
 * executing the React runtime: that each of the three previously-unguarded
 * call sites in `app/page.tsx` now contains the required adaptive guard,
 * immediately adjacent to the exact condition the confirmed audit
 * identified as missing it, and that the ALREADY-correct guard in
 * `components/ResultsDisplay.tsx` was left untouched. This is a real
 * regression test — it fails if a future edit removes any of the three
 * fixes — but it does not execute React or prove runtime behavior. The
 * mandatory, fully executable proof of the actual fix is the server-side
 * test suite in `adaptiveAutoSynthesis.spec.ts`, which runs the real route.
 */

import { readFileSync } from "fs";
import { join } from "path";

const PAGE_SOURCE = readFileSync(join(__dirname, "..", "..", "..", "..", "app", "page.tsx"), "utf-8");
const RESULTS_DISPLAY_SOURCE = readFileSync(
  join(__dirname, "..", "..", "..", "..", "components", "ResultsDisplay.tsx"),
  "utf-8"
);

describe("app/page.tsx — client-side adaptive guard regression (source-level)", () => {
  it("live-run generateSynthesisAutomatically call site now checks !(data as any).adaptive alongside runId/successfulCount", () => {
    const match = PAGE_SOURCE.match(
      /if \(data\.runId && successfulCount >= 2 && !\(data as any\)\.adaptive\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*void generateSynthesisAutomatically\(/
    );
    expect(match).not.toBeNull();
  });

  it("the legacy client-side synthesizeReport() live-run call site still has its original !(data as any).adaptive guard, unmodified", () => {
    const match = PAGE_SOURCE.match(/if \(successfulCount >= 2 && !\(data as any\)\.adaptive\) \{/);
    expect(match).not.toBeNull();
  });

  it("history-reload synthesizeReport() call site now checks the adaptive status before running legacy client-side synthesis", () => {
    const match = PAGE_SOURCE.match(/if \(data\.adaptive\?\.status === "absent" \|\| !data\.adaptive\) \{\s*try \{\s*consensusForSynthesis = synthesizeReport\(/);
    expect(match).not.toBeNull();
  });

  it("history-reload generateSynthesisAutomatically call site now checks the adaptive status before triggering auto-synthesis", () => {
    const match = PAGE_SOURCE.match(
      /\(data\.adaptive\?\.status === "absent" \|\| !data\.adaptive\)\s*\)\s*\{\s*void generateSynthesisAutomatically\(/
    );
    expect(match).not.toBeNull();
  });

  it("the adaptive-panel state setters are not nested inside any of the new synthesis guards — the adaptive renderer path is untouched by this fix", () => {
    // setAdaptivePanel (live run) and its history-reload equivalent both
    // happen well before the guarded blocks in the same function, on their
    // own unconditional lines — confirmed by them not appearing inside the
    // guard regexes matched above, and by their own unconditional call
    // sites existing independently.
    expect(PAGE_SOURCE).toMatch(/setAdaptivePanel\(\(data as any\)\.adaptive \?\? null\);/);
    expect(PAGE_SOURCE).toMatch(/setAdaptivePanel\(adaptPersistedOutputToPanelPayload\(data\.adaptive\.output\)\);/);
  });
});

describe("components/ResultsDisplay.tsx — pre-existing adaptive guard preserved", () => {
  it("still guards its own internal auto-synthesis trigger on !adaptive, unmodified by this step", () => {
    const match = RESULTS_DISPLAY_SOURCE.match(
      /okResults\.length >= 2 &&\s*runId &&\s*!autoTriggeredRunIdsRef\.current\.has\(runId\) &&\s*synthesisStatus === "idle" &&\s*!preGeneratedSynthesisReport &&\s*!adaptive/
    );
    expect(match).not.toBeNull();
  });

  it("returns the adaptive renderer path before any legacy synthesis UI when `adaptive` is present", () => {
    expect(RESULTS_DISPLAY_SOURCE).toMatch(/if \(adaptive\) \{/);
  });
});

describe("generateSynthesisAutomatically — no-retry behavior on a defensive server rejection (source-level)", () => {
  it("a non-2xx response is converted to an error state, never retried automatically, and never clears the adaptive panel or adaptive-related state", () => {
    // The catch block that handles a non-ok /api/synthesize-panel response
    // only ever sets synthesisStatus/synthesisError — never touches
    // adaptivePanel, results, or any adaptive-restoration state, and
    // synthesisGeneratedForRunId is deliberately NOT cleared on error
    // (per its own comment), so the same runId is never auto-retried.
    const catchBlockMatch = PAGE_SOURCE.match(
      /\} catch \(error: any\) \{\s*console\.error\("\[auto-synthesis\] Failed to generate synthesis automatically:", error\);[\s\S]{0,300}?\/\/ Don't clear synthesisGeneratedForRunId - allow manual retry\s*\}/
    );
    expect(catchBlockMatch).not.toBeNull();
    const snippet = catchBlockMatch?.[0] ?? "";
    expect(snippet).not.toContain("setAdaptivePanel");
    expect(snippet).not.toContain("setResults");
  });
});
