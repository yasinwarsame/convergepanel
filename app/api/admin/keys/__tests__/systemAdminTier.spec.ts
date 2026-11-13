/**
 * Phase FIRST-ADMIN-C2 — `/api/admin/keys` is SYSTEM_ADMIN only.
 *
 * This route reads and writes the shared PROVIDER API CREDENTIALS. An
 * ADMIN_EMAILS member reaching it would put every model provider key behind an
 * email address on an allowlist.
 *
 * As with set-role, the C2 mutation set showed the tier was asserted nowhere.
 * These tests assert the authorization outcome and the absence of any read or
 * write of the credential document.
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
  dbLog,
  dbStore,
  installPrivilegedHarness,
  routeRequest,
  signInAs,
  type Credentials,
} from "@/lib/admin/__tests__/privilegedRouteHarness";
import { GET, POST } from "../route";

installPrivilegedHarness();

const get = (c: Credentials) => GET(routeRequest("/api/admin/keys", { creds: c }));
const post = (c: Credentials) => POST(routeRequest("/api/admin/keys", { method: "POST", body: { chatgpt: "sk-invented-not-a-real-key" }, creds: c }));
const touchedKeys = () => dbLog.some((e) => e.path.startsWith("appConfig"));

describe("/api/admin/keys — SYSTEM_ADMIN tier", () => {
  it("THE CORE PROOF: a verified ADMIN_EMAILS member cannot READ the credentials", async () => {
    const res = await get({ bearer: signInAs("portal").bearer });
    expect(res.status).toBe(403);
    expect(touchedKeys()).toBe(false);
  });

  it("THE CORE PROOF: a verified ADMIN_EMAILS member cannot WRITE the credentials", async () => {
    const res = await post({ bearer: signInAs("portal").bearer });
    expect(res.status).toBe(403);
    expect(touchedKeys()).toBe(false);
    expect(dbStore.has("appConfig/modelKeys")).toBe(false);
  });

  it("the live admin custom claim is admitted, and the credential document is then read", async () => {
    const res = await get({ bearer: signInAs("system").bearer });
    expect(res.status).toBe(200);
    expect(touchedKeys()).toBe(true);
  });

  it("an unauthenticated caller is refused", async () => {
    expect((await get({})).status).toBe(401);
    expect(touchedKeys()).toBe(false);
  });

  it("a session cookie alone never reaches this route, even holding the claim", async () => {
    const res = await get({ cookie: signInAs("system").cookie });
    expect(res.status).toBe(401);
    expect(touchedKeys()).toBe(false);
    expect(authCalls.getUser).not.toHaveBeenCalled();
  });
});
