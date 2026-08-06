/**
 * Phase 2 pilot history-reload fix — app/page.tsx's history-reload routing
 * regression test (source-level).
 *
 * SCOPE NOTE (same as app/api/synthesize-panel/__tests__/
 * clientAdaptiveGuardRegression.spec.ts, which established this pattern):
 * this repo's jest config has no DOM-rendering library installed, so
 * rendering app/page.tsx and simulating a real history-reload click isn't
 * feasible without new test infrastructure. This file verifies the fix at
 * the SOURCE level instead — the exact conditions the confirmed bug report
 * identified as missing/wrong are now present, in the right order, with
 * the right consequence. It fails if a future edit reintroduces the bug
 * (JSON leak / legacy Unified Answer fallback for a procedural history
 * reload) even though it can't execute React to prove the rendered pixels.
 *
 * The bug this covers: `data.adaptive?.status === "absent"` is the
 * DESIGNED, CORRECT status for every procedural run (that envelope only
 * ever applies to the 9 Milestone-2 schemas) — but two call sites used
 * that status as a false proxy for "this run is legacy/non-adaptive",
 * routing a real, structured, schema-routed run into the synthesizeReport()
 * prose engine and the legacy Unified Answer UI. The fix adds a second,
 * independent envelope (`legacyAdaptive`) and checks it at both sites.
 */

import { readFileSync } from "fs";
import { join } from "path";

const PAGE_SOURCE = readFileSync(join(__dirname, "..", "page.tsx"), "utf-8");

describe("app/page.tsx — legacyAdaptive restore branch (Phase 2 pilot history-reload fix)", () => {
  it("checks data.legacyAdaptive?.status === 'valid' as an ELSE IF after the Milestone-2 adaptive branch — never instead of it, never before it", () => {
    const match = PAGE_SOURCE.match(
      /if \(data\.adaptive\?\.status === "valid" && data\.adaptive\.output\) \{[\s\S]{0,400}?\} else if \(data\.legacyAdaptive\?\.status === "valid" && data\.legacyAdaptive\.output\) \{/
    );
    expect(match).not.toBeNull();
  });

  it("the legacyAdaptive branch calls adaptPersistedLegacyOutputToPanelPayload with the real persisted output, and clears the restore notice — same success contract as the Milestone-2 branch", () => {
    const match = PAGE_SOURCE.match(
      /else if \(data\.legacyAdaptive\?\.status === "valid" && data\.legacyAdaptive\.output\) \{[\s\S]{0,300}?setAdaptivePanel\(adaptPersistedLegacyOutputToPanelPayload\(data\.legacyAdaptive\.output\)\);[\s\S]{0,50}?setAdaptiveRestoreNotice\(null\);/
    );
    expect(match).not.toBeNull();
  });

  it("the malformed/unsupported_version restore-failure notice checks BOTH envelopes, not just the Milestone-2 one — a corrupted legacyAdaptiveOutput must not silently look like a plain absent/legacy run", () => {
    expect(PAGE_SOURCE).toMatch(
      /data\.adaptive\?\.status === "malformed" \|\| data\.legacyAdaptive\?\.status === "malformed"/
    );
    expect(PAGE_SOURCE).toMatch(
      /data\.adaptive\?\.status === "unsupported_version" \|\| data\.legacyAdaptive\?\.status === "unsupported_version"/
    );
  });

  it("adaptPersistedLegacyOutputToPanelPayload is imported alongside the existing Milestone-2 adapter", () => {
    expect(PAGE_SOURCE).toMatch(
      /import \{ adaptPersistedOutputToPanelPayload, adaptPersistedLegacyOutputToPanelPayload \} from "@\/lib\/user\/adaptivePersistedOutputAdapter";/
    );
  });
});

describe("app/page.tsx — history-reload synthesizeReport() JSON-leak fix (Phase 2 pilot)", () => {
  it("THE FIX: the synthesizeReport() trigger now also requires legacyAdaptive to be genuinely absent — this is the literal line that used to misroute every procedural history reload into the prose-oriented synthesizer, producing the JSON-leak bug", () => {
    const legacyAbsentDeclaration = PAGE_SOURCE.match(
      /const legacyAdaptiveAbsent = !data\.legacyAdaptive \|\| data\.legacyAdaptive\.status === "absent";/
    );
    expect(legacyAbsentDeclaration).not.toBeNull();

    const guardedCall = PAGE_SOURCE.match(
      /if \(\(data\.adaptive\?\.status === "absent" \|\| !data\.adaptive\) && legacyAdaptiveAbsent\) \{\s*try \{\s*consensusForSynthesis = synthesizeReport\(/
    );
    expect(guardedCall).not.toBeNull();
  });

  it("a bare 'adaptive absent' check, WITHOUT the legacyAdaptiveAbsent guard, no longer exists anywhere in the file — the exact regression this test protects against", () => {
    // The old, buggy condition (still valid JS syntax, so a careless
    // revert wouldn't be caught by tsc/lint) must not reappear verbatim.
    const oldBuggyCondition = /if \(data\.adaptive\?\.status === "absent" \|\| !data\.adaptive\) \{\s*try \{\s*consensusForSynthesis = synthesizeReport\(/;
    expect(PAGE_SOURCE).not.toMatch(oldBuggyCondition);
  });
});

describe("app/page.tsx — legacyAdaptive response type is declared", () => {
  it("the fetch response type includes legacyAdaptive alongside the existing adaptive field", () => {
    expect(PAGE_SOURCE).toMatch(/legacyAdaptive\?: \{\s*status: string;\s*output: PersistedLegacyAdaptiveOutputV1 \| null;\s*\};/);
  });

  it("PersistedLegacyAdaptiveOutputV1 is imported from persistedOutput.ts", () => {
    expect(PAGE_SOURCE).toMatch(
      /import type \{ PersistedAdaptiveOutput, PersistedLegacyAdaptiveOutputV1 \} from "@\/lib\/adaptiveSchema\/persistedOutput";/
    );
  });
});
