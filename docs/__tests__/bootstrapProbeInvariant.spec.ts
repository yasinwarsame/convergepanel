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

/** Human-facing files: docs, runbooks, READMEs and production source comments. */
const FILES = execSync("git ls-files -- '*.md' '*.ts' '*.tsx' '*.mjs'", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.includes("__tests__") && !f.includes("__fixtures__"))
  .filter((f) => readFileSync(f, "utf8").includes(ROUTE));

/** Words that make a passage an instruction to CHECK a credential's status. */
const VERIFICATION_CONTEXT =
  /\bverif|\bprove\b|\bproof\b|is dead\b|no longer (works|accepted)|\brotat|containment|liveness|\bprobe\b|still (live|accepted|works)|must return 401/i;

/** A request body naming a claim target. */
const UID_FIELD = /["']?uid["']?\s*[:=]/;
const SECRET_FIELD = /["']?secret["']?\s*[:=]/;

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

  it("it prescribes a credential-only body", () => {
    expect(src).toContain('{"secret": "<OLD_SECRET>"}');
    expect(src.replace(/\s+/g, " ")).toContain('{"secret": "<OLD_SECRET>"} <- no uid, ever');
  });

  it("the enrollment procedure defers to it rather than restating a probe", () => {
    const enrollment = src.slice(
      src.indexOf("**Option 2 — the bootstrap route.**"),
      src.indexOf("### Password admin session")
    );
    expect(enrollment).toContain("§B.6.c");
    expect(enrollment).toContain("no uid, ever");
    expect(uidBearingBodies(enrollment.split("\n"))).toHaveLength(0);
  });
});

describe("response semantics are pinned by MEANING, not by wording", () => {
  /**
   * C9-R6 rewrote the 400 row to "denied. Containment achieved." and every test
   * stayed green, because only the 429 row and one sentence were pinned. The
   * table now carries stable verdict tokens, so the assertion is about what a
   * status MEANS.
   */
  const src = readFileSync("docs/operations/admin-authority-tiers.md", "utf8");
  const rows = src.split("\n").filter((l) => /^\s*\|\s*(401|400|429|5xx|any other)\s*\|/.test(l));

  it("ANCHOR: the verdict table was found, with a row per status", () => {
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  const verdictFor = (status: string) => {
    const row = rows.find((l) => new RegExp(`^\\s*\\|\\s*${status}\\s*\\|`).test(l));
    expect(row).toBeDefined();
    return row!;
  };

  it("401 means the credential was REJECTED and containment is proven", () => {
    const row = verdictFor("401");
    expect(row).toContain("CREDENTIAL_REJECTED");
    expect(row).toMatch(/[Cc]ontainment proven/);
  });

  it("400 means the credential was ACCEPTED and containment FAILED", () => {
    const row = verdictFor("400");
    expect(row).toContain("CREDENTIAL_ACCEPTED");
    expect(row).toMatch(/[Cc]ontainment FAILED/);
    // The inversion that survived C9: 400 must never be described as success.
    expect(row).not.toMatch(/containment (proven|achieved|complete|confirmed)/i);
  });

  it.each(["429", "5xx"])("%s is INCONCLUSIVE, never proof", (status) => {
    const row = verdictFor(status);
    expect(row).toContain("INCONCLUSIVE");
    expect(row).not.toMatch(/containment (proven|achieved|complete|confirmed)/i);
  });

  it("no status other than 401 is described as proving containment", () => {
    for (const row of rows) {
      if (row.includes("CREDENTIAL_REJECTED")) continue;
      expect(row).not.toMatch(/containment (proven|achieved|complete|confirmed)/i);
    }
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
    const step8 = SECTION.slice(SECTION.indexOf("8. **Re-enumerate"));
    expect(step8).toMatch(/Not only when secret exposure is suspected/);
  });
});
