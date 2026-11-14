/**
 * Phase FIRST-ADMIN-C2 — `/api/admin/set-role` is SYSTEM_ADMIN only.
 *
 * This route MINTS the `admin: true` custom claim. If an ADMIN_EMAILS member
 * could reach it, the email allowlist would become a self-service path to the
 * highest privilege in the product, and every other tier boundary would be
 * decorative.
 *
 * The C2 mutation set proved this was asserted nowhere: swapping the bearer
 * SYSTEM_ADMIN guard for the ADMIN_PORTAL guard survived the whole suite. These
 * tests assert the AUTHORIZATION OUTCOME — status plus the absence of any
 * privilege write — not which helper the module happens to import.
 */

/*
 * SEC-3 / S2-b: driven through the real privileged-access guard (doubles only
 * at the Firebase Admin SDK boundary — privilegedRouteHarness). Denial status
 * codes are the guard's: an authenticated non-holder is 403 (was 401), a
 * missing or cookie-only credential is 401.
 */

jest.mock("@/lib/firebase/admin", () => require("@/lib/admin/__tests__/privilegedRouteHarness").firebaseAdminModuleDouble());

import {
  authCalls,
  authState,
  dbWrites,
  installPrivilegedHarness,
  routeRequest,
  signInAs,
  type Credentials,
} from "@/lib/admin/__tests__/privilegedRouteHarness";
import { POST } from "../route";

installPrivilegedHarness();

const req = (c: Credentials) => POST(routeRequest("/api/admin/set-role", { method: "POST", body: { uid: "target-uid", role: "admin" }, creds: c }));
beforeEach(() => {
  authState.records.set("target-uid", { uid: "target-uid", email: "t@test-invented.example", emailVerified: false, disabled: false, customClaims: {} });
});

describe("POST /api/admin/set-role — SYSTEM_ADMIN tier", () => {
  it("THE CORE PROOF: a verified ADMIN_EMAILS member with no claim is refused, and mints nothing", async () => {
    const res = await req({ bearer: signInAs("portal").bearer });
    expect(res.status).toBe(403);
    expect(authCalls.setCustomUserClaims).not.toHaveBeenCalled();
    expect(dbWrites()).toEqual([]);
  });

  it("a verified GOVERNANCE_ADMIN_EMAILS member is refused, and mints nothing", async () => {
    const res = await req({ bearer: signInAs("governance").bearer });
    expect(res.status).toBe(403);
    expect(authCalls.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("the live admin custom claim is admitted and mints the claim", async () => {
    const res = await req({ bearer: signInAs("system").bearer });
    expect(res.status).toBe(200);
    expect(authCalls.setCustomUserClaims).toHaveBeenCalledWith("target-uid", expect.objectContaining({ admin: true }));
  });

  it("an unauthenticated caller is refused", async () => {
    const res = await req({});
    expect(res.status).toBe(401);
    expect(authCalls.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("a session cookie alone never reaches this route, even holding the claim", async () => {
    const res = await req({ cookie: signInAs("system").cookie });
    expect(res.status).toBe(401);
    expect(authCalls.setCustomUserClaims).not.toHaveBeenCalled();
  });
});
