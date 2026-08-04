/**
 * Auth Lifecycle Hardening, Step 6.15 — structural/source-level tests for
 * `AuthProvider.tsx`. `jest.config.ts` runs `testEnvironment: "node"` (no
 * DOM), so `onIdTokenChanged`'s async callback sequence — the actual
 * behavior under test — cannot be exercised via a real render/effect cycle
 * the way it would under jsdom + React Testing Library. Consistent with
 * this codebase's established pattern for such components (see
 * `AdaptiveMultiReviewerPanelSection`'s own test file), the state
 * transitions themselves are covered by `authSessionStateMachine.spec.ts`
 * (pure reducer, every branch), the race protection by
 * `authGeneration.spec.ts`, and the network contract by
 * `sessionSync.spec.ts` (all fully DOM-free and directly exercised). These
 * tests instead prove the WIRING — that `AuthProvider` actually uses those
 * exact modules, in the shape the root-cause fix depends on — by asserting
 * against the source directly.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "AuthProvider.tsx"), "utf8");

describe("AuthProvider — source-level wiring guarantees", () => {
  it("listens to onIdTokenChanged, not onAuthStateChanged — the fix requires reacting to token refreshes too, not just sign-in/out", () => {
    expect(source).toMatch(/import\s*\{[^}]*\bonIdTokenChanged\b[^}]*\}\s*from\s*["']firebase\/auth["']/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bonAuthStateChanged\b[^}]*\}\s*from\s*["']firebase\/auth["']/);
    expect(source).not.toMatch(/\bonAuthStateChanged\(/);
  });

  it("uses the pure session-sync state machine reducer, not ad-hoc boolean state", () => {
    expect(source).toMatch(/nextSessionSyncState/);
    expect(source).toMatch(/useReducer/);
  });

  it("uses the operation-generation guard to discard stale async results", () => {
    expect(source).toMatch(/createGenerationGuard/);
    expect(source).toMatch(/generationGuard\.isCurrent/);
  });

  it("establishes the server session via the shared sessionSync helper — never a raw inline fetch to the session endpoint", () => {
    expect(source).toMatch(/establishServerSession/);
    expect(source).not.toMatch(/fetch\(\s*["']\/api\/auth\/session["']/);
  });

  it("defensively clears the server session when Firebase reports no user, and again on any sync failure", () => {
    // Once directly for the signed-out branch, once inside the fail-closed sync-failure branch (via establishServerSession's own internal clearServerSession call — asserted in sessionSync.spec.ts).
    const clearCalls = source.match(/clearServerSession\(\)/g) ?? [];
    expect(clearCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("signs the Firebase client out on a sync failure or uid mismatch — the previous identity is never retained on the client either", () => {
    expect(source).toMatch(/session_sync_failed/);
    expect(source).toMatch(/await signOut\(auth\)/);
  });

  it("distinguishes a new identity (uid changed) from a same-uid token refresh", () => {
    expect(source).toMatch(/isNewIdentity/);
    expect(source).toMatch(/prevUidRef\.current !== nextUser\.uid/);
  });

  it("exposes syncState, canMutate, and beginLogout on the context — not just user/loading", () => {
    expect(source).toMatch(/syncState/);
    expect(source).toMatch(/canMutate/);
    expect(source).toMatch(/beginLogout/);
    expect(source).toMatch(/canPerformProtectedMutation/);
  });

  it("logs a stale-operation-discarded event when a generation check fails, rather than silently dropping it with no observability", () => {
    expect(source).toMatch(/stale_auth_operation_discarded/);
  });
});
