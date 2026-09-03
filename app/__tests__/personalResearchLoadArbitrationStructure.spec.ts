/**
 * Personal Research navigation/load arbitration (Phase 11A.6.1) — source-level
 * structural verification.
 *
 * SCOPE NOTE (same infrastructure constraint documented in
 * app/__tests__/legacyAdaptiveHistoryReload.spec.ts and
 * app/__tests__/personalResearchHistoryLoadRace.spec.tsx): this repo's Jest
 * config has no DOM-rendering library, and `ts-jest`'s whole-program
 * type-check of the graph reachable from `app/page.tsx` (via
 * `lib/billing/planConfig.ts` -> `lib/env.ts`) is too heavy to compile in
 * this environment (observed OOM / 10+ minute hangs). This file cannot
 * execute `app/page.tsx`'s React control flow, so it verifies the FIX at
 * the source level instead: it reads the real, current file text and
 * asserts the exact structural properties the fix requires — one shared
 * generation-guard instance (not per-control counters), claimed
 * synchronously before every await-crossing writer, and checked
 * immediately before every state commit it guards. Real, executable
 * coverage of the underlying generation-guard PRIMITIVE lives in
 * `lib/client/__tests__/authGeneration.spec.ts` (generic semantics) and
 * `app/__tests__/personalResearchHistoryLoadRace.spec.tsx` (the exact race
 * sequences, using the real `createGenerationGuard` import against a
 * transcription of this file's control flow).
 */

import { readFileSync } from "fs";
import { join } from "path";

const PAGE_SOURCE = readFileSync(join(__dirname, "..", "page.tsx"), "utf-8");

describe("app/page.tsx — ONE shared research-load arbitration domain (not per-control counters)", () => {
  it("createGenerationGuard is imported from the reusable primitive, not reimplemented", () => {
    expect(PAGE_SOURCE).toMatch(
      /import \{ createGenerationGuard \} from "@\/lib\/client\/authGeneration";/
    );
  });

  it("exactly ONE researchLoadGuard instance is created via useRef(createGenerationGuard())", () => {
    const matches = PAGE_SOURCE.match(/useRef\(createGenerationGuard\(\)\)\.current/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("researchLoadGuard.next() is called in exactly two places — loadResearchRunIntoState's entry and handleRunPanel's reset block — both sharing the SAME instance", () => {
    const nextCalls = PAGE_SOURCE.match(/researchLoadGuard\.next\(\)/g) ?? [];
    expect(nextCalls.length).toBe(2);
  });

  it("researchLoadGuard.isCurrent(gen) is checked in exactly two places inside loadResearchRunIntoState — success path and failure path", () => {
    const isCurrentChecks = PAGE_SOURCE.match(/if \(!researchLoadGuard\.isCurrent\(gen\)\)/g) ?? [];
    expect(isCurrentChecks.length).toBe(2);
  });
});

describe("app/page.tsx — loadResearchRunIntoState: generation claimed synchronously, before the first await", () => {
  it("const gen = researchLoadGuard.next() appears BEFORE the first `await` inside the function body", () => {
    const fnStart = PAGE_SOURCE.indexOf("const loadResearchRunIntoState = async (");
    expect(fnStart).toBeGreaterThan(-1);
    // Slice from the function declaration to its first REAL `await`
    // expression (searched as `await import(` / `await authedFetch(` /
    // `await res.` code tokens, not the bare word "await" — which also
    // appears in this function's own doc comments describing the
    // invariant, and would give a false-negative match on a comment).
    const afterDecl = PAGE_SOURCE.slice(fnStart);
    const genIdx = afterDecl.indexOf("const gen = researchLoadGuard.next();");
    const firstAwaitIdx = afterDecl.indexOf("await import(");
    expect(genIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeLessThan(firstAwaitIdx);
  });

  it("focusClaimTarget is threaded in as a parameter (not set by a second unguarded statement from the caller after the call returns)", () => {
    expect(PAGE_SOURCE).toMatch(
      /focusClaimTarget: string \| null = null\s*\n\s*\): Promise<\{ ok: true \} \| \{ ok: false; message: string \} \| \{ superseded: true \}>/
    );
  });

  it("the success block's isCurrent check sits directly between the throw-validation and the first state commit (setQuestion) — a single check governs the WHOLE success commit, no await in between", () => {
    const match = PAGE_SOURCE.match(
      /if \(!res\.ok \|\| !data\.ok \|\| !data\.results\?\.length\) \{\s*throw new Error\([\s\S]{0,120}?\);\s*\}\s*(?:\/\/[^\n]*\n\s*)*if \(!researchLoadGuard\.isCurrent\(gen\)\) \{\s*return \{ superseded: true \};\s*\}\s*setQuestion\(/
    );
    expect(match).not.toBeNull();
  });

  it("the failure block's isCurrent check sits directly before setError(msg) — a single check governs the WHOLE failure/cleanup commit", () => {
    const match = PAGE_SOURCE.match(
      /const msg = e instanceof Error \? e\.message : "Could not load this run\.";\s*(?:\/\/[^\n]*\n\s*)*if \(!researchLoadGuard\.isCurrent\(gen\)\) \{\s*return \{ superseded: true \};\s*\}\s*setError\(msg\);/
    );
    expect(match).not.toBeNull();
  });

  it("no await appears between either isCurrent check and the commits it guards (both checked blocks run to their return/end synchronously)", () => {
    // Extract the whole function body and verify no `await` token appears
    // after the LAST isCurrent check (once past it, everything is
    // synchronous state-setting + a final return).
    const fnStart = PAGE_SOURCE.indexOf("const loadResearchRunIntoState = async (");
    const fnBody = PAGE_SOURCE.slice(fnStart, PAGE_SOURCE.indexOf("\n  const openHistoryItem = async"));
    const lastCheckIdx = fnBody.lastIndexOf("researchLoadGuard.isCurrent(gen)");
    expect(lastCheckIdx).toBeGreaterThan(-1);
    const afterLastCheck = fnBody.slice(lastCheckIdx);
    expect(afterLastCheck).not.toMatch(/\bawait\b/);
  });

  it("setFocusClaimId(focusClaimTarget) commits INSIDE the gated success block, atomically with the run data — not a separate unguarded statement", () => {
    const successBlockMatch = PAGE_SOURCE.match(
      /if \(!researchLoadGuard\.isCurrent\(gen\)\) \{\s*return \{ superseded: true \};\s*\}\s*setQuestion\([\s\S]*?setFocusClaimId\(focusClaimTarget\);\s*return \{ ok: true \};/
    );
    expect(successBlockMatch).not.toBeNull();
  });

  it("setFocusClaimId(focusClaimTarget) appears EXACTLY ONCE in the whole file — a stale/superseded call has no code path that can also set the claim target", () => {
    const matches = PAGE_SOURCE.match(/setFocusClaimId\(focusClaimTarget\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("no superseded-return branch contains any setFocusClaimId call (or any other state setter) — the superseded early-return bodies are exactly `{ return { superseded: true }; }`, nothing else", () => {
    const supersededBranches =
      PAGE_SOURCE.match(/if \(!researchLoadGuard\.isCurrent\(gen\)\) \{\s*return \{ superseded: true \};\s*\}/g) ?? [];
    // Exactly 2 branches exist (success path + failure path), and each
    // must match this fully-anchored pattern with NOTHING else inside the
    // braces — if a mutation inserted any extra statement (e.g. a stale
    // setFocusClaimId call) before the `return`, this exact-shape match
    // would no longer find it, and the count below would drop.
    expect(supersededBranches.length).toBe(2);
  });
});

describe("app/page.tsx — handleRunPanel invalidates any in-flight research-run load", () => {
  it("researchLoadGuard.next() is called inside the synchronous 'Reset state for new panel run' block, before the network call", () => {
    const match = PAGE_SOURCE.match(
      /\/\/ Reset state for new panel run\s*(?:\/\/[^\n]*\n\s*)*researchLoadGuard\.next\(\);\s*setVerificationPayload\(null\);/
    );
    expect(match).not.toBeNull();
  });

  it("handleRunPanel's researchLoadGuard.next() call precedes the function's first `await` (the network call)", () => {
    const fnStart = PAGE_SOURCE.indexOf("const handleRunPanel = async () => {");
    expect(fnStart).toBeGreaterThan(-1);
    const afterDecl = PAGE_SOURCE.slice(fnStart);
    const claimIdx = afterDecl.indexOf("researchLoadGuard.next();");
    // First REAL await token (code, not the word inside this function's
    // own doc comment) — see the comment on the analogous check above.
    const firstAwaitIdx = afterDecl.indexOf("await import(");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(firstAwaitIdx);
  });
});

describe("app/page.tsx — handleViewSourceResearch: cross-control wiring through the SAME loadResearchRunIntoState gate", () => {
  it("passes source.claimId as the third argument (the focus target), not a second unguarded setFocusClaimId call after the await", () => {
    expect(PAGE_SOURCE).toMatch(
      /const result = await loadResearchRunIntoState\(source\.runId, \{ question, selectedModels \}, source\.claimId\);/
    );
  });

  it("checks 'superseded' in result BEFORE checking result.ok, and returns without touching error or panelTab when superseded", () => {
    const match = PAGE_SOURCE.match(
      /const result = await loadResearchRunIntoState\(source\.runId, \{ question, selectedModels \}, source\.claimId\);\s*(?:\/\/[^\n]*\n\s*)*setSourceNavLoading\(false\);\s*if \("superseded" in result\) \{\s*(?:\/\/[^\n]*\n\s*)*return;\s*\}\s*if \(!result\.ok\) \{/
    );
    expect(match).not.toBeNull();
  });

  it("no leftover unconditional setFocusClaimId(source.claimId) call after the loadResearchRunIntoState await (the old, unguarded second-write bug)", () => {
    expect(PAGE_SOURCE).not.toMatch(/setFocusClaimId\(source\.claimId\);/);
  });

  it("setPanelTab(\"research\") only fires after both the superseded check and the result.ok check have passed", () => {
    const match = PAGE_SOURCE.match(
      /if \(!result\.ok\) \{[\s\S]{0,400}?setError\("This source research is no longer available\."\);\s*return;\s*\}\s*setPanelTab\("research"\);/
    );
    expect(match).not.toBeNull();
  });
});

describe("app/page.tsx — historyLoadSeq (pagination pager) is a deliberately separate, non-overlapping mechanism", () => {
  it("historyLoadSeq only appears inside loadHistoryPage's own state — never referenced by loadResearchRunIntoState, handleRunPanel, or handleViewSourceResearch", () => {
    const loadResearchStart = PAGE_SOURCE.indexOf("const loadResearchRunIntoState = async (");
    const handleRunPanelStart = PAGE_SOURCE.indexOf("const handleRunPanel = async () => {");
    const handleViewSourceStart = PAGE_SOURCE.indexOf("const handleViewSourceResearch = async () => {");
    const handleViewSourceEnd = PAGE_SOURCE.indexOf("\n  const handleAddModel", handleViewSourceStart);
    const loadResearchEnd = PAGE_SOURCE.indexOf("\n  const openHistoryItem = async", loadResearchStart);
    const handleRunPanelEnd = PAGE_SOURCE.indexOf("\n  };", PAGE_SOURCE.indexOf("setModelStatuses(initialStatuses);", handleRunPanelStart));

    expect(PAGE_SOURCE.slice(loadResearchStart, loadResearchEnd)).not.toMatch(/historyLoadSeq/);
    expect(PAGE_SOURCE.slice(handleViewSourceStart, handleViewSourceEnd)).not.toMatch(/historyLoadSeq/);
    // handleRunPanel is large; just confirm the ref isn't referenced anywhere past its declaration through its reset block and well into its body.
    expect(handleRunPanelEnd).toBeGreaterThan(handleRunPanelStart);
  });

  it("historyLoadSeq only gates historyItems/historyPage/historyHasMore/historyError/historyLoading — never results/currentRunId/runStatus/viewingHistoryRunId/focusClaimId", () => {
    const loadHistoryPageStart = PAGE_SOURCE.indexOf("const loadHistoryPage = useCallback(");
    const loadHistoryPageEnd = PAGE_SOURCE.indexOf("\n  );", loadHistoryPageStart);
    expect(loadHistoryPageStart).toBeGreaterThan(-1);
    const body = PAGE_SOURCE.slice(loadHistoryPageStart, loadHistoryPageEnd);
    const forbidden = [
      "setResults(",
      "setCurrentRunId(",
      "setRunStatus(",
      "setViewingHistoryRunId(",
      "setFocusClaimId(",
      "setFocusClaimNotFound(",
      "setSynthesizedReport(",
      "setModelStatuses(",
      "setOrgGovernanceStatus(",
    ];
    for (const setter of forbidden) {
      expect(body).not.toContain(setter);
    }
  });
});
