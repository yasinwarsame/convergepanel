/** Project/Research Assignment (D10) — the dedicated admission axis, independent of every other flag. */
import { resolveProjectAssignmentAdmission, parseProjectAssignmentCanaryUids, MAX_PROJECT_ASSIGNMENT_CANARY_UIDS } from "../projectAssignmentRollout";

describe("resolveProjectAssignmentAdmission", () => {
  it("off by default: neither flag ⇒ not admitted, source off", () => {
    expect(resolveProjectAssignmentAdmission({ uid: "u1", globalEnabled: false, canaryUidsRaw: undefined })).toEqual({ admitted: false, source: "off", canaryConfigInvalid: false });
  });
  it("canary uid admits only the listed uid", () => {
    expect(resolveProjectAssignmentAdmission({ uid: "u1", globalEnabled: false, canaryUidsRaw: "u1, u2" }).admitted).toBe(true);
    expect(resolveProjectAssignmentAdmission({ uid: "u1", globalEnabled: false, canaryUidsRaw: "u1, u2" }).source).toBe("canary");
    expect(resolveProjectAssignmentAdmission({ uid: "u3", globalEnabled: false, canaryUidsRaw: "u1, u2" }).admitted).toBe(false);
  });
  it("global admits everyone", () => {
    expect(resolveProjectAssignmentAdmission({ uid: "anyone", globalEnabled: true, canaryUidsRaw: undefined })).toEqual({ admitted: true, source: "global", canaryConfigInvalid: false });
  });
  it("an over-cap canary list is invalid config and admits nobody through the canary path", () => {
    const raw = Array.from({ length: MAX_PROJECT_ASSIGNMENT_CANARY_UIDS + 1 }, (_, i) => `u${i}`).join(",");
    const parsed = parseProjectAssignmentCanaryUids(raw);
    expect(parsed).toEqual({ ok: false, reason: "too_many_entries" });
    expect(resolveProjectAssignmentAdmission({ uid: "u0", globalEnabled: false, canaryUidsRaw: raw })).toEqual({ admitted: false, source: "off", canaryConfigInvalid: true });
  });
});
