/**
 * Phase FIRST-ADMIN-C4 — PRIVILEGED ADDRESSES MUST NOT REACH THE LOGS.
 *
 * The governance queue route logged the FULL effective `GOVERNANCE_ADMIN_EMAILS`
 * list on every GET. That is the highest-authority identity set in the product,
 * and it was harmless only because the list is empty — it would have started
 * disclosing real addresses to anyone with runtime-log access the moment the
 * first governance administrator was enrolled, which is precisely the change
 * this whole pre-enrollment phase exists to make safe.
 *
 * Diagnostics keep the SHAPE (configured / valid / invalid counts) and the
 * caller's own membership boolean. They never keep the addresses.
 */

const __PRIVILEGED_ENV_SNAPSHOT = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(__PRIVILEGED_ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

import { governanceAdminListShapeForLog, isGovernanceAdminEmail } from "@/lib/admin/config";

/** Distinctive enough that any leak is unambiguous. */
const LOCAL = "c4-redaction-canary";
const DOMAIN = "leak-detector-invented.example";
const SECRET_ADDRESS = `${LOCAL}@${DOMAIN}`;
const SECOND = `second-canary@${DOMAIN}`;

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = `${SECRET_ADDRESS},${SECOND}`;
});

describe("the governance diagnostic never carries privileged addresses", () => {
  const shape = () => governanceAdminListShapeForLog();

  it("THE CORE PROOF: the full address is absent", () => {
    expect(shape()).not.toContain(SECRET_ADDRESS);
    expect(shape()).not.toContain(SECOND);
  });

  it("the local part is absent", () => {
    expect(shape()).not.toContain(LOCAL);
  });

  it("the domain is absent", () => {
    expect(shape()).not.toContain(DOMAIN);
  });

  it("no '@' appears at all, so no address can be hiding in any form", () => {
    expect(shape()).not.toContain("@");
  });

  it("the useful shape IS retained: configured / valid / invalid counts", () => {
    expect(shape()).toBe("configured=2 valid=2 invalid=0");
  });

  it("an invalid (non-ASCII) entry is counted, not printed", () => {
    process.env.GOVERNANCE_ADMIN_EMAILS = `${SECRET_ADDRESS},ａdmin@${DOMAIN}`;
    const out = shape();
    expect(out).toBe("configured=2 valid=1 invalid=1");
    expect(out).not.toContain(DOMAIN);
    expect(out).not.toContain("ａ");
  });

  it("an empty list reports zero rather than an empty-looking address field", () => {
    process.env.GOVERNANCE_ADMIN_EMAILS = "";
    expect(shape()).toBe("configured=0 valid=0 invalid=0");
  });

  it("an unset list does not throw and reports zero", () => {
    delete process.env.GOVERNANCE_ADMIN_EMAILS;
    expect(shape()).toBe("configured=0 valid=0 invalid=0");
  });

  it("per-caller membership stays available as a boolean, which leaks nothing", () => {
    process.env.GOVERNANCE_ADMIN_EMAILS = SECRET_ADDRESS;
    expect(isGovernanceAdminEmail(SECRET_ADDRESS)).toBe(true);
    expect(isGovernanceAdminEmail(`someone-else@${DOMAIN}`)).toBe(false);
  });
});

describe("the queue route's log line composes only redacted parts", () => {
  it("the emitted diagnostic contains no privileged address", () => {
    // Reproduces the exact composition used at the call site.
    const email = `unrelated@${DOMAIN}`;
    const line =
      `[governance] governance-allowlist membership="${isGovernanceAdminEmail(email)}", ` +
      `emailVerified=true, grantsAuthority=false, governanceList=${governanceAdminListShapeForLog()}`;
    expect(line).not.toContain(SECRET_ADDRESS);
    expect(line).not.toContain(SECOND);
    expect(line).not.toContain(LOCAL);
    expect(line).toContain("configured=2");
  });

  it("REGRESSION: the removed helper that joined the list must not come back", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require("@/lib/admin/config") as Record<string, unknown>;
    expect(config.governanceAdminEmailsForLog).toBeUndefined();
    for (const [name, value] of Object.entries(config)) {
      if (typeof value !== "function" || value.length !== 0) continue;
      const out = (value as () => unknown)();
      if (typeof out === "string") {
        expect(out).not.toContain(SECRET_ADDRESS);
        expect(out).not.toContain(LOCAL);
      }
    }
  });
});
