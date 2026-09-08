/**
 * Phase FIRST-ADMIN-C10 — THE BOOTSTRAP-PROBE INVARIANT, REPOSITORY-WIDE.
 *
 * `/api/admin/set-admin` validates the shared secret BEFORE the uid. So a
 * "check whether the old secret still works" request that carries a uid does
 * not report a failure when the secret is still live — it MINTS `admin: true`
 * on that uid, with no audit record and no success log. The verification step
 * becomes the breach.
 *
 * C9 fixed the sentence that said this in the incident section. C9-R6 then
 * found the SAME instruction still standing, unqualified, in the enrollment
 * procedure — the one that runs first — three files from a route docstring
 * handing the operator the exact dangerous curl. The C9 guard did not catch it
 * because it was an exact-phrase negative scoped to one section: a reword or a
 * different section walked straight past it.
 *
 * So this test does not blacklist a sentence. It enforces a CLASS:
 *
 *   1. A uid-bearing request body to this route is a MINT. Every one must be
 *      marked `MINTS-AUTHORITY`, wherever it lives.
 *   2. No verification / containment / liveness instruction anywhere in the
 *      repository may contain a uid-bearing body.
 *
 * Rule 2 is the security property. Rule 1 exists so that a mint example cannot
 * be quietly repurposed as a probe by a later edit that adds verification
 * wording around it.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROUTE = "/api/admin/set-admin";

/**
 * EVERY tracked text file that mentions the route — not a curated extension
 * list. C10 globbed `*.md,*.ts,*.tsx,*.mjs` while its header claimed
 * "repository-wide", and a review landed a dangerous probe in a `.js` operator
 * script, a `.sh`, a `.txt` and a `.json`, all invisible. Three tracked `.js`
 * admin-minting scripts already existed in the blind spot.
 *
 * Binary and lockfile-ish paths are excluded by extension; everything else that
 * git tracks and that mentions the route is scanned.
 */
const SKIP = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip|lock)$|^package-lock\.json$/i;
const FILES = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.includes("__tests__") && !f.includes("__fixtures__"))
  .filter((f) => !SKIP.test(f))
  .filter((f) => {
    try { return readFileSync(f, "utf8").includes(ROUTE); } catch { return false; }
  });

/** Words that make a passage an instruction to CHECK a credential's status. */
const VERIFICATION_CONTEXT =
  /\bverif|\bprove\b|\bproof\b|is dead\b|no longer (works|accepted)|\brotat|containment|liveness|\bprobe\b|still (live|accepted|works)|must return 401/i;

/** A request body naming a claim target. */
// `\\"` covers the shell form `-d "{\\"uid\\":\\"$U\\",...}"`, which C10's
// pattern could not match and which is the idiomatic way to write a curl body
// with variable interpolation.
const UID_FIELD = /(\\?["'])?uid(\\?["'])?\s*[:=]/;
const SECRET_FIELD = /(\\?["'])?secret(\\?["'])?\s*[:=]/;

/** Every place a uid and a secret appear together in one request body. */
function uidBearingBodies(lines: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!UID_FIELD.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    if (SECRET_FIELD.test(window)) hits.push(i);
  }
  return hits;
}

const near = (lines: string[], i: number, radius: number) =>
  lines.slice(Math.max(0, i - radius), i + radius + 1).join("\n");

describe("ANCHORS — the scan is looking at real content", () => {
  it("finds the files that actually reference the bootstrap route", () => {
    // A broken glob or filter yielding [] would satisfy every rule below.
    expect(FILES.length).toBeGreaterThanOrEqual(3);
    expect(FILES).toEqual(expect.arrayContaining([
      "README.md",
      "app/api/admin/set-admin/route.ts",
      "docs/operations/admin-authority-tiers.md",
      // Files C10's four-extension whitelist could not see.
      ".env.local.example",
      "docs/technical-documentation.md",
      "CLAUDE.md",
    ]));
  });

  it("finds real uid-bearing bodies to police", () => {
    // If the detector matched nothing, rule 1 would be vacuous.
    const total = FILES.reduce((n, f) => n + uidBearingBodies(readFileSync(f, "utf8").split("\n")).length, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("the detector recognises the dangerous shapes it must catch", () => {
    // Proves UID_FIELD/SECRET_FIELD actually fire, on both curl and JSON forms.
    expect(uidBearingBodies([`-d '{"uid": "U", "secret": "S"}'`])).toHaveLength(1);
    expect(uidBearingBodies([`{`, `  "uid": "U",`, `  "secret": "S"`, `}`])).toHaveLength(1);
    expect(uidBearingBodies([`{"secret": "S"}`])).toHaveLength(0); // the safe probe
    // The escaped-quote shell form, which C10 could not see.
    expect(uidBearingBodies([`-d "{\\"uid\\":\\"$U\\",\\"secret\\":\\"$S\\"}"`])).toHaveLength(1);
  });

  it("a labelled escape still has to carry a real prohibition", () => {
    // Guards the escape hatch: a marker alone must not launder an instruction.
    const marked = ["SAFE-PROBE:PROHIBITION", `-d '{"uid":"U","secret":"S"}'`, "use this to verify rotation"];
    expect(/\b(never|not|must not|do not)\b/i.test(marked.join("\n"))).toBe(false);
  });

  it("the verification-context detector recognises rephrasings", () => {
    for (const phrase of [
      "verify the old value is dead",
      "to prove the secret no longer works",
      "confirm the rotation took effect",
      "a liveness probe for the credential",
      "check it is still accepted",
      "POST with it must return 401",
    ]) {
      expect(VERIFICATION_CONTEXT.test(phrase)).toBe(true);
    }
  });
});

describe.each(FILES)("%s", (file) => {
  const lines = readFileSync(file, "utf8").split("\n");
  const bodies = uidBearingBodies(lines);

  it("every uid-bearing request body is marked MINTS-AUTHORITY", () => {
    for (const i of bodies) {
      const context = near(lines, i, 12);
      expect({ file, line: i + 1, marked: /MINTS-AUTHORITY/.test(context) })
        .toEqual({ file, line: i + 1, marked: true });
    }
  });

  it("no verification or containment instruction carries a uid", () => {
    /**
     * THE SECURITY PROPERTY. A uid-bearing body sitting inside a passage that
     * reads as "check whether this credential still works" is the defect,
     * however it is worded and wherever it lives.
     */
    for (const i of bodies) {
      const context = near(lines, i, 10);
      /**
       * Two labelled escapes, both of which must be written deliberately:
       *   ANTI-EXAMPLE — a demonstration of the unsafe form.
       *   PROHIBITION  — a warning that FORBIDS using this body as a probe.
       * The second exists because a good warning necessarily contains
       * verification wording ("never use this to check whether the old secret
       * still works"). A prohibition must also actually prohibit, so the
       * negation is required too — a bare marker is not enough.
       */
      if (/SAFE-PROBE:(ANTI-EXAMPLE|PROHIBITION)/.test(context)) {
        expect({ file, line: i + 1, prohibits: /\b(never|not|must not|do not)\b/i.test(context) })
          .toEqual({ file, line: i + 1, prohibits: true });
        continue;
      }
      const offending = VERIFICATION_CONTEXT.exec(context)?.[0] ?? null;
      expect({ file, line: i + 1, verificationWording: offending })
        .toEqual({ file, line: i + 1, verificationWording: null });
    }
  });
});

describe("the canonical safe probe is defined exactly once and is uid-less", () => {
  const RUNBOOK = "docs/operations/admin-authority-tiers.md";
  const src = readFileSync(RUNBOOK, "utf8");

  it("exactly one canonical probe block exists", () => {
    expect(src.match(/SAFE-PROBE:CANONICAL/g) ?? []).toHaveLength(1);
  });

  it("it prescribes a credential-only body, and no uid-bearing body exists anywhere", () => {
    expect(src).toContain('{"secret": "<OLD_SECRET>"}');
    // Phase FIRST-ADMIN-C14 (R10 P2-3): this used to be anchored on a block the
    // document itself labelled "what NOT to do", so deleting that block — the
    // correct cleanup — broke CI. The invariant is now stated over the whole
    // runbook and does not depend on deprecated text existing.
    expect(uidBearingBodies(src.split("\n"))).toHaveLength(0);
  });

  it("the enrollment procedure defers to the canonical tool and states no rival verdict rule", () => {
    const enrollment = src.slice(
      src.indexOf("**Option 2 — the bootstrap route.**"),
      src.indexOf("### Password admin session")
    );
    expect(enrollment).toContain("--production-two-phase");
    expect(enrollment).toMatch(/Never send a uid/);
    expect(uidBearingBodies(enrollment.split("\n"))).toHaveLength(0);
    // R10 AA: a second, contradictory verdict rule must not survive beside it.
    expect(enrollment).not.toMatch(/only result that closes the window/);
    expect(enrollment).toContain("PRODUCTION_CONTAINMENT_PROVEN");
  });
});

describe("PROOF SEMANTICS — a single response is never containment", () => {
  /**
   * Phase FIRST-ADMIN-C13. The exit-code table this replaces described a
   * one-shot verdict. Review showed a single 401 proves only that the origin
   * contacted rejected the string supplied — and that both halves fail open
   * with no attacker: a preview/staging instance with an unset secret returns
   * the GENUINE marker, and a shell-mangled secret is rejected by the LIVE
   * route. The documented proof is now a bound state transition.
   */
  const src = readFileSync("docs/operations/admin-authority-tiers.md", "utf8");
  const flat = src.replace(/\s+/g, " ");

  it("ANCHOR: the containment probe section was found", () => {
    expect(src).toContain("SAFE-PROBE:CANONICAL");
    expect(src).toContain("production-two-phase");
  });

  it("requires the PRE observation to ACCEPT before any rotation", () => {
    expect(flat).toMatch(/\*\*PRE\*\* — before you rotate anything/);
    expect(flat).toContain("400 + `credential-accepted`");
    expect(flat).toMatch(/the run \*\*aborts\*\*/);
  });

  it("requires the POST observation to REJECT the SAME secret at the SAME origin", () => {
    expect(flat).toContain("same locked origin and the same");
    expect(flat).toContain("401 + `credential-rejected`");
  });

  it("only the transition proves containment", () => {
    expect(flat).toContain("Only `PRE accepted -> POST rejected` prints `PRODUCTION_CONTAINMENT_PROVEN`");
  });

  it("states plainly that a wrong origin or a mangled secret would otherwise pass", () => {
    expect(flat).toMatch(/INCLUDING when `ADMIN_SECRET` is unset/);
    expect(flat).toMatch(/mangled by your shell/);
  });

  it("the single-shot mode is explicitly NOT containment evidence", () => {
    expect(flat).toMatch(/can never print `PRODUCTION_CONTAINMENT_PROVEN`/);
    expect(flat).toMatch(/Do not use it as enrollment or containment evidence/);
  });

  it("the header is described as a ROUTE MARKER, not attestation", () => {
    expect(flat).toContain("ROUTE MARKER");
    expect(flat).toMatch(/\*\*not\*\* cryptographic attestation/);
    expect(flat).toMatch(/world-readable in a public repository/);
  });

  it("429 aborts the run rather than counting as anything", () => {
    expect(flat).toMatch(/a 429 tells you nothing about the credential and aborts the run/);
  });
});

describe("containment imperatives are present and unconditional", () => {
  const src = readFileSync("docs/operations/admin-authority-tiers.md", "utf8");
  const SECTION = src.slice(
    src.indexOf("### B. SYSTEM_ADMIN (claim-derived)"),
    src.indexOf("### What this procedure does NOT give you")
  );

  it("ANCHOR: the containment section was located", () => {
    expect(SECTION).toContain("revokeRefreshTokens");
    expect(SECTION.length).toBeGreaterThan(1500);
  });

  it("instructs the responder to DISABLE the compromised account", () => {
    expect(SECTION).toMatch(/\*\*Disable the affected Firebase Auth account\*\*/);
  });

  it("names the actual session-invalidation mechanism rather than gesturing at one", () => {
    expect(SECTION).toContain("verifySessionCookie(cookie, true)");
    expect(SECTION.replace(/\s+/g, " ")).toContain("there is no separate session-invalidation endpoint");
  });

  it("does not claim disablement cuts off the bearer path immediately", () => {
    expect(SECTION.replace(/\s+/g, " ")).toContain("Disabling does **not** shorten that window");
  });

  it("claim re-enumeration is UNCONDITIONAL, not nested in the exposure branch", () => {
    // C9 nested it under "if the secret may have been exposed", so a responder
    // who judged no exposure never re-enumerated — while step 1 had removed the
    // claim from exactly one account.
    expect(SECTION).toMatch(/Re-enumerate privileged claims across all accounts — unconditionally/);
    const step8 = SECTION.slice(SECTION.indexOf("[CONTAINMENT_REENUMERATE_CLAIMS]"));
    expect(step8).toMatch(/Not only when secret exposure is suspected/);
  });
});

describe("admin-minting operator scripts are classified — BY CONTENT, not by name", () => {
  /**
   * Phase FIRST-ADMIN-C12 (R8 P1-3). The previous inventory globbed
   * `scripts/set-admin*`, so `scripts/setAdmin.ts` — which mints `admin: true`
   * — was invisible purely because of its camelCase name. A reviewer proved the
   * gap was structural: a tracked minting script carrying the explicit
   * instruction "use this to check whether the old ADMIN_SECRET still works"
   * passed the whole suite.
   *
   * That is the same blind-spot-by-naming-convention this file's own header
   * describes for the old four-extension whitelist, recurring one level over.
   * Authority-minting is identified by two textual signatures: a
   * `setCustomUserClaims` call together with an admin-true claim object (in
   * `admin: true`, `"admin": true` or shorthand `{ admin }` form), or a
   * reference to the bootstrap route alongside a uid. That covers the forms
   * this repository uses. It does NOT solve arbitrary program analysis —
   * wrapper indirection, computed member access, concatenated route paths, and
   * tools written outside `scripts/` in a non-JS/TS language are accepted
   * residuals, listed in docs/operations/security-test-falsifiability.md.
   */
  const SCRIPT_FILES = execSync("git ls-files -- 'scripts/*' 'scripts/**'", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(js|cjs|mjs|ts|tsx)$/.test(f))
    .filter((f) => !f.includes("__tests__"));

  /** A tool mints authority if it sets the admin claim, or posts a uid to the bootstrap route. */
  const mintsAuthority = (src: string) => {
    /**
     * Phase FIRST-ADMIN-C13 (R9 P2). The line-comment stripper used to eat
     * everything from `https://` onward, because it treated the `//` in a URL
     * scheme as a comment start. Any script written with a full absolute URL
     * literal was therefore invisible to the route rule. Only strip `//` when
     * it is not preceded by `:`.
     */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // `{ admin: true }`, `{ "admin": true }`, and property shorthand `{ admin }`.
    const setsClaim =
      /setCustomUserClaims\s*\(/.test(code) &&
      (/["']?admin["']?\s*:\s*true/.test(code) || /\{[^}]*\badmin\b[^}:]*\}/.test(code));
    // Any uid reference alongside the bootstrap route — shorthand `{ uid, secret }`
    // carries no colon, so matching `uid:` alone missed the obvious form. The
    // canonical probe contains no `uid` identifier at all, so it stays clear.
    const postsUidToBootstrap =
      code.includes("/api/admin/set-admin") && /\buid\b/i.test(code);
    return setsClaim || postsUidToBootstrap;
  };

  const MINTING = SCRIPT_FILES.filter((f) => mintsAuthority(readFileSync(f, "utf8")));

  it("ANCHOR: the content scan reads real scripts and finds the known minting tools", () => {
    expect(SCRIPT_FILES.length).toBeGreaterThan(5);
    expect(MINTING).toEqual(expect.arrayContaining([
      "scripts/set-admin-by-uid.js",
      "scripts/set-admin-claim.js",
      "scripts/set-admin-simple.js",
      // The camelCase file the filename glob could not see.
      "scripts/setAdmin.ts",
    ]));
  });

  it("ANCHOR: the predicate is discriminating, not universal", () => {
    // If it matched everything, "all minting scripts are classified" would be
    // satisfied by classifying everything.
    expect(MINTING.length).toBeLessThan(SCRIPT_FILES.length);
    expect(MINTING).not.toContain("scripts/probe-admin-secret.mjs");
    expect(MINTING).not.toContain("scripts/lib/probe-admin-secret.mjs");
  });

  it.each(MINTING)("%s declares itself authority-minting", (file) => {
    expect(readFileSync(file, "utf8")).toContain("MINTS-AUTHORITY");
  });

  it.each(MINTING)("%s states it is not a secret-liveness probe", (file) => {
    const src = readFileSync(file, "utf8").replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ");
    expect(src).toMatch(/never a secret-liveness probe|not a (secret-)?liveness probe/i);
    expect(src).toContain("probe-admin-secret.mjs");
  });

  it("the canonical probe is NOT classified as a minting tool", () => {
    const probe = readFileSync("scripts/lib/probe-admin-secret.mjs", "utf8");
    expect(probe).not.toContain("MINTS-AUTHORITY");
    expect(mintsAuthority(probe)).toBe(false);
  });

  it("SELF-VALIDATION: the predicate catches a minting script under any name", () => {
    // The exact evasions a reviewer used: camelCase, and a novel filename.
    expect(mintsAuthority(`await adminAuth.setCustomUserClaims(uid, { admin: true });`)).toBe(true);
    expect(mintsAuthority(`fetch("/api/admin/set-admin", { body: JSON.stringify({ uid, secret }) })`)).toBe(true);
    // ...and does not fire on the probe's own shape.
    expect(mintsAuthority(`fetch(url + "/api/admin/set-admin", { body: JSON.stringify({ secret }) })`)).toBe(false);
    // C13: an absolute URL literal is no longer mistaken for a comment.
    expect(mintsAuthority(`await fetch("https://x.test/api/admin/set-admin", { body: JSON.stringify({ uid, secret }) });`)).toBe(true);
    // C13: property shorthand and a quoted key both count as minting.
    expect(mintsAuthority(`const admin = true; await setCustomUserClaims(uid, { admin });`)).toBe(true);
    expect(mintsAuthority(`await setCustomUserClaims(uid, { "admin": true });`)).toBe(true);
    // ...nor on prose about minting.
    expect(mintsAuthority(`// this script does not call setCustomUserClaims with admin: true`)).toBe(false);
  });
});


// ===========================================================================
describe("BOOTSTRAP SEQUENCE ORDER — the pre-check precedes every mutation", () => {
  /**
   * Phase FIRST-ADMIN-C14 (R10 P0, item 26). Both documented sequences told the
   * operator to rotate AND DEPLOY before running the tool whose pre-check
   * requires the old secret to still be accepted. Following the numbering made
   * the mandated artifact unobtainable, and the natural recovery — putting the
   * old secret back so PRE passes — re-opens the hole being closed.
   *
   * Prose cannot be trusted to hold an order, so the order is now data.
   */
  const RUNBOOK = "docs/operations/admin-authority-tiers.md";
  const src = readFileSync(RUNBOOK, "utf8");

  const STEPS = [
    "BOOTSTRAP_SET_SECRET",
    "BOOTSTRAP_PRECHECK",
    "BOOTSTRAP_MINT",
    "BOOTSTRAP_VERIFY_MINT",
    "BOOTSTRAP_ROTATE_SECRET",
    "BOOTSTRAP_DEPLOY_ROTATION",
    "BOOTSTRAP_POSTCHECK",
    "BOOTSTRAP_REENUMERATE",
    "BOOTSTRAP_VERIFY_AUTHZ",
  ] as const;

  const stepAt = (id: string) => src.indexOf(`[${id}][REQUIRED]`);

  it("ANCHOR: every step id appears exactly once as a numbered step", () => {
    for (const id of STEPS) {
      expect(src.match(new RegExp(`\\[${id}\\]\\[REQUIRED\\]`, "g")) ?? []).toHaveLength(1);
      expect(stepAt(id)).toBeGreaterThan(-1);
    }
  });

  it("every step is declared MUST in the sequence table", () => {
    for (const id of STEPS) {
      const row = src.split("\n").find((l) => l.includes(`\`${id}\``) && l.trim().startsWith("|"));
      expect(row).toBeDefined();
      expect(row!.trim().endsWith("| MUST |")).toBe(true);
    }
    expect(src).not.toMatch(/\| `BOOTSTRAP_[A-Z_]+` \|[^|]*\| (MAY|SHOULD|OPTIONAL) \|/);
  });

  it("PRECHECK precedes the mint, the rotation, the deployment and the post-check", () => {
    expect(stepAt("BOOTSTRAP_PRECHECK")).toBeLessThan(stepAt("BOOTSTRAP_MINT"));
    expect(stepAt("BOOTSTRAP_PRECHECK")).toBeLessThan(stepAt("BOOTSTRAP_ROTATE_SECRET"));
    expect(stepAt("BOOTSTRAP_PRECHECK")).toBeLessThan(stepAt("BOOTSTRAP_DEPLOY_ROTATION"));
    expect(stepAt("BOOTSTRAP_PRECHECK")).toBeLessThan(stepAt("BOOTSTRAP_POSTCHECK"));
    expect(stepAt("BOOTSTRAP_MINT")).toBeLessThan(stepAt("BOOTSTRAP_ROTATE_SECRET"));
    expect(stepAt("BOOTSTRAP_ROTATE_SECRET")).toBeLessThan(stepAt("BOOTSTRAP_DEPLOY_ROTATION"));
    expect(stepAt("BOOTSTRAP_DEPLOY_ROTATION")).toBeLessThan(stepAt("BOOTSTRAP_POSTCHECK"));
  });

  it("the numbered steps appear in exactly the declared order", () => {
    const positions = STEPS.map(stepAt);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("the incident sequence also starts the probe BEFORE the rotation", () => {
    const b6 = src.slice(src.indexOf("If there is ANY possibility the secret was exposed"));
    const probe = b6.indexOf("[CONTAINMENT_PROBE_OLD_SECRET][REQUIRED]");
    const rotate = b6.indexOf("Rotate `ADMIN_SECRET` to a new value");
    const deploy = b6.indexOf("**Deploy deliberately.**");
    expect(probe).toBeGreaterThan(-1);
    expect(rotate).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(rotate);
    expect(probe).toBeLessThan(deploy);
  });

  it("a post-check that does not prove containment is documented as retryable, not terminal", () => {
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/leave the proof \*\*armed\*\* and retryable/);
  });
});
