/**
 * Phase 7B — resolveProjectsUiEligibility() tests. The central property
 * under test: UI eligibility is the AND of the UI rollout and the
 * backend rollout — a security/operability invariant, not an incidental
 * detail (see the module's own doc comment for why).
 */

import { resolveProjectsUiEligibility } from "@/lib/projects/projectsUiEligibility";

const UID = "uid-1";

function eligibility(overrides: Partial<Parameters<typeof resolveProjectsUiEligibility>[0]> = {}) {
  return resolveProjectsUiEligibility({
    uid: UID,
    uiGlobalEnabled: false,
    uiCanaryUidsRaw: undefined,
    backendGlobalEnabled: false,
    backendCanaryUidsRaw: undefined,
    ...overrides,
  });
}

describe("resolveProjectsUiEligibility — combined AND", () => {
  it("backend off + UI off -> false", () => {
    expect(eligibility({ backendGlobalEnabled: false, uiGlobalEnabled: false })).toBe(false);
  });

  it("backend on + UI off -> false", () => {
    expect(eligibility({ backendGlobalEnabled: true, uiGlobalEnabled: false })).toBe(false);
  });

  it("backend off + UI on -> false", () => {
    expect(eligibility({ backendGlobalEnabled: false, uiGlobalEnabled: true })).toBe(false);
  });

  it("backend on + UI on -> true", () => {
    expect(eligibility({ backendGlobalEnabled: true, uiGlobalEnabled: true })).toBe(true);
  });

  it("UI canary hit + backend canary hit (same uid, independent cohorts) -> true", () => {
    expect(
      eligibility({
        uiGlobalEnabled: false,
        uiCanaryUidsRaw: UID,
        backendGlobalEnabled: false,
        backendCanaryUidsRaw: UID,
      })
    ).toBe(true);
  });

  it("SECURITY: UI canary hit but backend canary miss -> false (broader UI cohort than backend cohort must never leak through)", () => {
    expect(
      eligibility({
        uiGlobalEnabled: false,
        uiCanaryUidsRaw: UID,
        backendGlobalEnabled: false,
        backendCanaryUidsRaw: "someone-else",
      })
    ).toBe(false);
  });

  it("SECURITY: backend canary hit but UI canary miss -> false", () => {
    expect(
      eligibility({
        uiGlobalEnabled: false,
        uiCanaryUidsRaw: "someone-else",
        backendGlobalEnabled: false,
        backendCanaryUidsRaw: UID,
      })
    ).toBe(false);
  });

  it("backend globally enabled (as it already is in production) + UI canary hit -> true", () => {
    expect(
      eligibility({
        uiGlobalEnabled: false,
        uiCanaryUidsRaw: UID,
        backendGlobalEnabled: true,
        backendCanaryUidsRaw: undefined,
      })
    ).toBe(true);
  });

  it("backend globally enabled + UI off entirely -> false (matches current production reality: PROJECTS_ENABLED is global-equivalent via A+B canary is NOT the same as UI; here we test the literal global flag) — UI absence still wins", () => {
    expect(
      eligibility({
        uiGlobalEnabled: false,
        uiCanaryUidsRaw: undefined,
        backendGlobalEnabled: true,
        backendCanaryUidsRaw: undefined,
      })
    ).toBe(false);
  });

  it("MUTATION CHECK: an OR implementation would return true for 'backend off + UI on' — proving the AND test above is meaningful", () => {
    const orImplementation = (uiEnabled: boolean, backendEnabled: boolean) => uiEnabled || backendEnabled;
    expect(orImplementation(true, false)).toBe(true); // the mutated (wrong) behavior
    const real = eligibility({ backendGlobalEnabled: false, uiGlobalEnabled: true });
    expect(real).toBe(false); // the real function disagrees
  });
});
