/**
 * Phase FIRST-ADMIN-C2 — the ADMIN_PORTAL / SYSTEM_ADMIN capability contract.
 *
 * SYSTEM_ADMIN must be derivable ONLY from the Firebase custom claim, never
 * from an email allowlist. An ADMIN_EMAILS member reaching SYSTEM_ADMIN would
 * put provider credentials, admin-claim minting and bulk purge behind an email
 * address.
 *
 * SEC-3 / S2-b: the route is gated by the privileged-access guard, so both
 * tiers come from the LIVE Auth record (the claim on the presented token is
 * never an input). A caller holding no tier gets the guard's uniform denial —
 * 403 for an authenticated non-holder (was 401 before S2-b; the portal hook
 * reads only `res.ok`, so the UI is unaffected).
 */

jest.mock("@/lib/firebase/admin", () => require("@/lib/admin/__tests__/privilegedRouteHarness").firebaseAdminModuleDouble());

import { installPrivilegedHarness, routeRequest, signInAs, type Persona } from "@/lib/admin/__tests__/privilegedRouteHarness";
import { GET } from "../route";

installPrivilegedHarness();

const call = (p: Persona, opts: Parameters<typeof signInAs>[1] = {}) => {
  const me = signInAs(p, opts);
  return GET(routeRequest("/api/admin/access", { creds: { bearer: me.bearer } }));
};

describe("tier contract", () => {
  it("ADMIN_EMAILS-only -> adminPortal true, systemAdmin FALSE", async () => {
    const res = await call("portal");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, adminPortal: true, systemAdmin: false });
  });

  it("live custom claim (even with an UNVERIFIED email) -> adminPortal true, systemAdmin TRUE", async () => {
    const res = await call("system", { record: { emailVerified: false } });
    await expect(res.json()).resolves.toEqual({ ok: true, adminPortal: true, systemAdmin: true });
  });

  it("GOVERNANCE_ADMIN_EMAILS-only -> denied the portal entirely", async () => {
    const res = await call("governance");
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden", reason: "tier_not_held" });
  });

  it("an ordinary verified user is denied", async () => {
    expect((await call("ordinary")).status).toBe(403);
  });

  it("an UNVERIFIED ADMIN_EMAILS member is denied", async () => {
    expect((await call("portal", { record: { emailVerified: false } })).status).toBe(403);
  });

  it("a non-boolean LIVE admin claim does not yield systemAdmin", async () => {
    const res = await call("portal", { record: { customClaims: { admin: "true" } } });
    await expect(res.json()).resolves.toEqual({ ok: true, adminPortal: true, systemAdmin: false });
  });

  it("a token that still claims admin after the live claim was removed does not yield systemAdmin", async () => {
    const res = await call("portal", { tokenClaimAdmin: true });
    await expect(res.json()).resolves.toEqual({ ok: true, adminPortal: true, systemAdmin: false });
  });

  it("backward compatibility: `ok` is preserved and means ADMIN_PORTAL", async () => {
    const body = (await (await call("portal")).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.ok).toBe(body.adminPortal);
  });
});
