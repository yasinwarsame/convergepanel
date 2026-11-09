/**
 * THE BOOTSTRAP INVARIANT, REPOSITORY-WIDE — rewritten for security slice S1.
 *
 * History. `/api/admin/set-admin` validated a shared secret (`ADMIN_SECRET`,
 * "BOOTSTRAP_SECRET") BEFORE the uid, so a "check whether the old secret still
 * works" request carrying a uid silently MINTED `admin: true` — the verification
 * step became the breach. Phases C10–C17 policed that hazard with a uid-body
 * detector, a two-phase containment probe and an ordered BOOTSTRAP_* sequence.
 *
 * S1 deleted the route, the probe and the variable. Until the hardened operator
 * CLI (PR #295) merges, the only documented path for an emergency `admin` claim
 * change is an OWNER action, never an agent action: the reviewed SYSTEM_ADMIN
 * claim operator tool (`scripts/admin/set-system-admin-claim.ts`, branch
 * `fix/admin-claim-script-hardening`, PR #295) run LOCALLY from a checkout of its
 * exact reviewed commit f6039ea — explicit project and UID, dry run then typed
 * confirmation, audit rows and `--result-file` kept, no Production run without
 * separate authorization — verified with the read-only
 * `scripts/check-admin-claims.js` / `scripts/verify-admin-claims.js`. (Owner
 * ruling OPTION B, 2026-11-09: the Firebase Console cannot set custom claims or
 * revoke refresh tokens, so the earlier "Console" wording described no path.)
 * The four legacy minting scripts are NOT part of that path.
 *
 * What this file now enforces, over every tracked non-test file that mentions
 * an operator token (discovered from git, classified, and pinned):
 *
 *   N1. No operator site tells anyone to use the retired route, the old secret,
 *       its probe or a legacy claim-overwriting script: every sentence, list
 *       item or table row naming one of them must negate or retire it, and no
 *       site may carry an invocation of any of them.
 *   N2. No uid-bearing request body to the retired route exists anywhere.
 *   N3. The retired procedure (BOOTSTRAP_* sequence, SAFE-PROBE block, proof
 *       token) is gone from the runbook.
 *   P1. The interim path is documented where an operator looks for it.
 *   P2. Every legacy minting script — found BY CONTENT, not by name — declares
 *       itself DO NOT USE and points at the read-only checks.
 *
 * This needs a real checkout: discovery uses `git ls-files`.
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROUTE = "/api/admin/set-admin";
const RUNBOOK = "docs/operations/admin-authority-tiers.md";
const LEGACY_SCRIPTS = [
  "scripts/setAdmin.ts",
  "scripts/set-admin-simple.js",
  "scripts/set-admin-by-uid.js",
  "scripts/set-admin-claim.js",
] as const;
const READ_ONLY_CHECKS = ["scripts/check-admin-claims.js", "scripts/verify-admin-claims.js"] as const;

const SKIP = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip|lock)$|^package-lock\.json$/i;
const TRACKED = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.includes("__tests__") && !f.includes("__fixtures__"))
  .filter((f) => !SKIP.test(f))
  .filter((f) => existsSync(f));

const read = (f: string) => readFileSync(f, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

// ─── detectors (each self-validated below) ──────────────────────────────────

/** Names of the retired / forbidden operator tools. */
const FORBIDDEN_TARGET =
  /\/api\/admin\/set-admin\b|\bADMIN_SECRET\b|\bBOOTSTRAP_SECRET\b|probe-admin-secret|PRODUCTION_CONTAINMENT_PROVEN|\bsetAdmin\.ts\b|\bset-admin-(simple|by-uid|claim)\.js\b/;

/** A unit that names a forbidden target must say it is not to be used. */
const NEGATION = /\b(not|never|retired|removed|deleted|no longer)\b|n't\b|\b404\b/i;

/**
 * Invocation shapes — forbidden on every site regardless of surrounding
 * negation, because a command line is copy-pasted without its paragraph.
 */
const INVOCATIONS: RegExp[] = [
  /\bcurl\b[^\n]*set-admin\b(?!-)/,
  /\bfetch\s*\([^)\n]*\/api\/admin\/set-admin/,
  /\bnode\s+scripts\/(probe-admin-secret|set-admin-[\w-]+\.js|setAdmin)/,
  /\bts-node\b[^\n]*setAdmin\.ts/,
  /^\s*(export\s+)?(OLD_)?(ADMIN|BOOTSTRAP)_SECRET\s*=/m,
  /\bexport\s+OLD_ADMIN_SECRET\b/,
];

/** Sentences, list items and table rows: a negation in one cannot launder another. */
const units = (text: string) =>
  text.split(/(?<=[.!?])\s+|\n\s*\n|\n(?=\s*(?:[-*|>]|\d+\.|[a-z]\.)\s)/);

const recommendations = (text: string) =>
  units(text).filter((u) => FORBIDDEN_TARGET.test(u) && !NEGATION.test(u)).map(flat);

/**
 * The ruled interim path (owner OPTION B, 2026-11-09). Every operator site must
 * state each element; a site that reverts to "owner action in the Firebase
 * Console" (a path that does not exist) or drops the exact-commit pin, the
 * local-only rule, the dry run or the Production bar fails here.
 */
const INTERIM_PATH_PINS: readonly RegExp[] = [
  /set-system-admin-claim/, //                       the tool, by name
  /fix\/admin-claim-script-hardening/, //            its branch
  /PR #295/,
  /\bf6039ea\b/, //                                   the exact reviewed commit, short form
  /f6039eaecb659159f52019b7f4cff4cce6a4ed89/, //      and the full SHA `rev-parse HEAD` must print
  /locally\**,? from a checkout|run locally with the reviewed|local checkout/i, // local execution, as a phrase (the bare word "local" also matches unrelated text)
  /never from Vercel or any deployment/,
  /\bno defaults\b|Nothing is defaulted/i, //       explicit project and UID
  /--confirm-project/,
  /--target-uid/,
  /dry run/i,
  /--confirm-claim/, //                                typed confirmation
  /--result-file/, //                                  evidence kept outside the repo
  /audit rows/,
  /No Production (?:grant or revoke|execution) without (?:its own )?separate authorization/,
  /gated on S2/, //                                    interim: #295 unmerged
  /never an agent action/i,
];
const INTERIM_PATH_FORBIDDEN = /owner action in the Firebase Console/i;

const invocations = (text: string) =>
  INVOCATIONS.filter((re) => re.test(text)).map(String);

/** A request body naming a claim target (covers `\"uid\"` shell escaping). */
const UID_FIELD = /(\\?["'])?uid(\\?["'])?\s*[:=]/;
const SECRET_FIELD = /(\\?["'])?secret(\\?["'])?\s*[:=]/;
function uidBearingBodies(lines: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!UID_FIELD.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    if (SECRET_FIELD.test(window)) hits.push(i);
  }
  return hits;
}

describe("SELF-VALIDATION — every detector fires on what it must catch", () => {
  it("the recommendation detector catches re-added instructions and spares retirements", () => {
    for (const bad of [
      "To grant the first admin, POST the uid and secret to `/api/admin/set-admin`.",
      "Set `ADMIN_SECRET` to a freshly generated value and deploy it.",
      "For an emergency claim change, run `scripts/set-admin-by-uid.js`.",
      "Use scripts/setAdmin.ts to mint the first admin.",
      "- `scripts/set-admin-claim.js` sets the claim quickly",
      "| Bootstrap | `BOOTSTRAP_SECRET` | MUST |",
      "Verify the rotation with probe-admin-secret.",
    ]) {
      expect({ bad, caught: recommendations(bad).length > 0 }).toEqual({ bad, caught: true });
    }
    for (const ok of [
      "The route `/api/admin/set-admin` was retired in S1.",
      "Do not re-add `ADMIN_SECRET` to any environment.",
      "The legacy minting scripts (`scripts/setAdmin.ts`) are not part of this path.",
      "A current deployment answers 404 for `/api/admin/set-admin`.",
    ]) {
      expect({ ok, caught: recommendations(ok).length > 0 }).toEqual({ ok, caught: false });
    }
  });

  it("a negation in one list item does not launder the next one", () => {
    const text = "- Do not use the route.\n- Run `scripts/set-admin-by-uid.js <UID>` to grant admin.";
    expect(recommendations(text)).toHaveLength(1);
  });

  it("the invocation detector catches every command shape, even inside a negated paragraph", () => {
    for (const bad of [
      `curl -X POST http://localhost:3000/api/admin/set-admin -d '{}'`,
      `await fetch("https://x.test/api/admin/set-admin", { method: "POST" })`,
      "node scripts/set-admin-by-uid.js <UID>",
      "node scripts/probe-admin-secret.mjs --observe",
      "npx ts-node --compiler-options '{}' scripts/setAdmin.ts",
      "ADMIN_SECRET=your-long-random-secret-string",
      "export OLD_ADMIN_SECRET",
      "Do not ever run node scripts/setAdmin.ts",
    ]) {
      expect({ bad, caught: invocations(bad).length > 0 }).toEqual({ bad, caught: true });
    }
    for (const ok of [
      "node scripts/check-admin-claims.js <UID>",
      "The former `ADMIN_SECRET` check is gone.",
      "curl -s https://convergepanel.com/api/admin/set-role",
    ]) {
      expect({ ok, caught: invocations(ok).length > 0 }).toEqual({ ok, caught: false });
    }
  });

  it("the uid-body detector recognises the dangerous shapes", () => {
    expect(uidBearingBodies([`-d '{"uid": "U", "secret": "S"}'`])).toHaveLength(1);
    expect(uidBearingBodies([`{`, `  "uid": "U",`, `  "secret": "S"`, `}`])).toHaveLength(1);
    expect(uidBearingBodies([`-d "{\\"uid\\":\\"$U\\",\\"secret\\":\\"$S\\"}"`])).toHaveLength(1);
    expect(uidBearingBodies([`{"secret": "S"}`])).toHaveLength(0);
  });
});

// ─── discovery + classification ─────────────────────────────────────────────

describe("REPOSITORY-WIDE OPERATOR CONTRACT — discovered, classified, pinned", () => {
  /**
   * Phase C16/C17 lessons kept: the site list is DISCOVERED from git, every
   * discovery must be classified, and each KIND is pinned so retyping an entry
   * cannot silently drop assertions.
   */
  const DISCOVERED = TRACKED.filter((f) => FORBIDDEN_TARGET.test(read(f))).sort();

  type Kind =
    | "OPERATOR_INSTRUCTION" // N1 sentence rule + invocation rule
    | "HISTORICAL_RECORD" //    invocation rule only; marked superseded
    | "INVENTORY" //            invocation rule only; lists files, instructs nothing
    | "IMPLEMENTATION" //       invocation rule only; code comments
    | "MINTING_EXAMPLE"; //     P2 header contract

  const MANIFEST: Record<string, Kind> = {
    "CLAUDE.md": "OPERATOR_INSTRUCTION",
    "README.md": "OPERATOR_INSTRUCTION",
    "docs/operations/admin-authority-tiers.md": "OPERATOR_INSTRUCTION",
    "docs/technical-documentation.md": "OPERATOR_INSTRUCTION",
    "docs/operations/security-test-falsifiability.md": "HISTORICAL_RECORD",
    "docs/operations/firebase-environment-isolation.md": "INVENTORY",
    "lib/security/rateLimit.ts": "IMPLEMENTATION",
    "scripts/set-admin-by-uid.js": "MINTING_EXAMPLE",
    "scripts/set-admin-claim.js": "MINTING_EXAMPLE",
    "scripts/setAdmin.ts": "MINTING_EXAMPLE",
  };

  const sitesOf = (...kinds: Kind[]) =>
    Object.entries(MANIFEST).filter(([, k]) => kinds.includes(k)).map(([f]) => f).sort();

  it("ANCHOR: discovery found the known operator surfaces", () => {
    expect(DISCOVERED.length).toBeGreaterThanOrEqual(8);
    for (const f of ["CLAUDE.md", "README.md", RUNBOOK, "docs/technical-documentation.md"]) {
      expect(DISCOVERED).toContain(f);
    }
  });

  it("every discovered site is classified — a new one must be triaged, not ignored", () => {
    expect(DISCOVERED).toEqual(Object.keys(MANIFEST).sort());
  });

  it("the operator-instruction site list is itself pinned", () => {
    expect(sitesOf("OPERATOR_INSTRUCTION")).toEqual([
      "CLAUDE.md",
      "README.md",
      "docs/operations/admin-authority-tiers.md",
      "docs/technical-documentation.md",
    ]);
  });

  it.each(sitesOf("OPERATOR_INSTRUCTION"))(
    "N1 %s: every mention of the retired route, secret, probe or a legacy script negates it",
    (file) => {
      expect({ file, recommends: recommendations(read(file)) }).toEqual({ file, recommends: [] });
    }
  );

  it.each(sitesOf("OPERATOR_INSTRUCTION", "HISTORICAL_RECORD", "INVENTORY", "IMPLEMENTATION"))(
    "N1 %s: carries no invocation of the retired route, secret, probe or a legacy script",
    (file) => {
      expect({ file, invocations: invocations(read(file)) }).toEqual({ file, invocations: [] });
    }
  );

  it.each(DISCOVERED)("N2 %s: no uid-bearing request body exists", (file) => {
    const lines = read(file).split("\n");
    expect({ file, lines: uidBearingBodies(lines).map((i) => i + 1) }).toEqual({ file, lines: [] });
  });

  it.each(sitesOf("HISTORICAL_RECORD"))("%s is marked superseded by S1", (file) => {
    expect(flat(read(file))).toMatch(/Superseded by security slice S1/);
    expect(flat(read(file))).toMatch(/They are not instructions, and nothing in them is to be run/);
  });
});

// ─── the retired procedure is gone ──────────────────────────────────────────

describe("N3 — the retired bootstrap procedure is gone from the runbook", () => {
  const src = read(RUNBOOK);

  it("ANCHOR: the runbook was read and is substantial", () => {
    expect(src.length).toBeGreaterThan(10000);
    expect(src).toContain("### Secret bootstrap route — RETIRED (S1)");
  });

  it.each([
    "BOOTSTRAP-SEQUENCE:CANONICAL",
    "SAFE-PROBE:CANONICAL",
    "BOOTSTRAP_SET_SECRET",
    "BOOTSTRAP_PRECHECK",
    "BOOTSTRAP_MINT",
    "BOOTSTRAP_ROTATE_SECRET",
    "BOOTSTRAP_POSTCHECK",
    "BOOTSTRAP_POST_RATE_LIMITED",
    "PRODUCTION_CONTAINMENT_PROVEN",
    "credential-accepted",
    "x-convergepanel-admin-secret-probe",
    "Option 2 — the bootstrap route",
    "Option 1 — out-of-band service-account script",
    "ADMIN_SECRET_STATE",
    "--production-two-phase",
    "OLD_ADMIN_SECRET",
  ])("the runbook no longer contains %s", (token) => {
    expect(src).not.toContain(token);
  });

  it("no operator site points at the removed §B.6 probe procedure", () => {
    for (const f of ["CLAUDE.md", "README.md", RUNBOOK, "docs/technical-documentation.md"]) {
      expect({ f, b6: read(f).includes("§B.6") }).toEqual({ f, b6: false });
    }
  });

  it("the retired route, probe and attestation module are absent from the tree", () => {
    for (const f of [
      "app/api/admin/set-admin/route.ts",
      "scripts/probe-admin-secret.mjs",
      "scripts/lib/probe-admin-secret.mjs",
      "lib/security/adminSecretProbeAttestation.ts",
    ]) {
      expect({ f, tracked: TRACKED.includes(f), exists: existsSync(f) }).toEqual({ f, tracked: false, exists: false });
    }
  });

  it("the runbook states the route is deleted, the variable unread, and neither to be restored", () => {
    const s = flat(src);
    expect(s).toMatch(/\*\*The route is deleted\.\*\* `app\/api\/admin\/set-admin\/route\.ts` no longer exists/);
    expect(s).toMatch(/answers `404` for that path/);
    expect(s).toMatch(/No non-test file reads `ADMIN_SECRET` or `BOOTSTRAP_SECRET`/);
    expect(s).toMatch(/Do not re-add `ADMIN_SECRET` to any environment and do not restore the route/);
    expect(s).toMatch(/A deployment built before S1 still ships the retired route/);
  });
});

// ─── the interim path ───────────────────────────────────────────────────────

describe("P1 — the interim admin-claim path is documented where operators look", () => {
  const src = read(RUNBOOK);
  const section = src.slice(
    src.indexOf("### Interim path for an `admin` claim change"),
    src.indexOf("### Password admin session")
  );

  it("ANCHOR: the interim section was located", () => {
    expect(section.length).toBeGreaterThan(800);
  });

  it("names the owner and the reviewed local operator tool, and forbids agent and Console execution", () => {
    const s = flat(section);
    expect(s).toMatch(
      /\*\*owner action, run locally with the reviewed SYSTEM_ADMIN claim operator tool\*\*\. It is never an agent action/
    );
    expect(s).toMatch(/Change only the `admin` key/);
    expect(s).not.toMatch(INTERIM_PATH_FORBIDDEN);
    for (const re of INTERIM_PATH_PINS) expect({ re: String(re), hit: re.test(s) }).toEqual({ re: String(re), hit: true });
  });

  it("names the exact reviewed commit f6039ea and forbids Production execution without separate authorization", () => {
    const s = flat(section);
    // The pin is the commit, not the branch: a checkout of a later head is not the reviewed tool.
    expect(s).toMatch(/exact reviewed commit `f6039ea`/);
    expect(s).toMatch(/`git -C <checkout> rev-parse HEAD` must print `f6039eaecb659159f52019b7f4cff4cce6a4ed89`/);
    expect(s).toMatch(/\*\*Dry run first, then typed confirmation\.\*\* Without `--execute` the tool/);
    expect(s).toMatch(/\*\*No Production execution without separate authorization\.\*\* Each Production grant or revoke needs its own owner authorization/);
    expect(s).toMatch(/PR #295 is reviewed and approved but unmerged; its merge stays gated on S2/);
  });

  it("verification is the read-only checks", () => {
    for (const f of READ_ONLY_CHECKS) expect(section).toContain(f);
  });

  it("names every legacy minting script inside a do-not-use passage", () => {
    const s = flat(section);
    const start = s.indexOf("**The legacy minting scripts are NOT part of this path. Do not use them:**");
    expect(start).toBeGreaterThan(-1);
    const passage = s.slice(start, start + 600);
    for (const f of LEGACY_SCRIPTS) expect(passage).toContain(f);
  });

  it.each(["CLAUDE.md", "README.md", "docs/technical-documentation.md"])(
    "%s states the same interim path",
    (f) => {
      const s = flat(read(f));
      expect(s).toMatch(/owner action\**,? never an agent action/);
      expect(s).not.toMatch(INTERIM_PATH_FORBIDDEN);
      for (const re of INTERIM_PATH_PINS) expect({ f, re: String(re), hit: re.test(s) }).toEqual({ f, re: String(re), hit: true });
      expect(s).toContain("scripts/check-admin-claims.js");
      expect(s).toMatch(/not\** part of (that|this) path/);
    }
  );

  it("the read-only checks really are read-only", () => {
    for (const f of READ_ONLY_CHECKS) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code).toMatch(/getUser\(/);
      expect({ f, writes: code.match(/setCustomUserClaims|revokeRefreshTokens|updateUser|deleteUser|createUser|\.set\(|\.update\(|\.delete\(/g) ?? [] })
        .toEqual({ f, writes: [] });
    }
  });
});

// ─── legacy minting scripts, by content ─────────────────────────────────────

describe("P2 — admin-minting scripts are classified BY CONTENT and marked DO NOT USE", () => {
  /**
   * Phase C12 lesson kept: `scripts/setAdmin.ts` once escaped a filename glob.
   * Minting is detected by content — a `setCustomUserClaims` call with an
   * admin-true claim object, or any reference to the retired route alongside a
   * uid — so a new minting tool under any name must carry the header.
   */
  const SCRIPT_FILES = TRACKED.filter((f) => /^scripts\//.test(f) && /\.(js|cjs|mjs|ts|tsx)$/.test(f));

  const mintsAuthority = (src: string) => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const setsClaim =
      /setCustomUserClaims\s*\(/.test(code) &&
      (/["']?admin["']?\s*:\s*true/.test(code) || /\{[^}]*\badmin\b[^}:]*\}/.test(code));
    const postsUidToBootstrap = code.includes(ROUTE) && /\buid\b/i.test(code);
    return setsClaim || postsUidToBootstrap;
  };

  const MINTING = SCRIPT_FILES.filter((f) => mintsAuthority(read(f)));

  it("SELF-VALIDATION: the predicate catches a minting script under any name", () => {
    expect(mintsAuthority(`await adminAuth.setCustomUserClaims(uid, { admin: true });`)).toBe(true);
    expect(mintsAuthority(`const admin = true; await setCustomUserClaims(uid, { admin });`)).toBe(true);
    expect(mintsAuthority(`await setCustomUserClaims(uid, { "admin": true });`)).toBe(true);
    expect(mintsAuthority(`await fetch("https://x.test/api/admin/set-admin", { body: JSON.stringify({ uid, secret }) });`)).toBe(true);
    expect(mintsAuthority(`// this script does not call setCustomUserClaims with admin: true`)).toBe(false);
    expect(mintsAuthority(`const u = await auth.getUser(uid); console.log(u.customClaims);`)).toBe(false);
  });

  it("ANCHOR: the content scan finds exactly the known legacy minting tools", () => {
    expect(SCRIPT_FILES.length).toBeGreaterThan(5);
    expect(MINTING.sort()).toEqual([...LEGACY_SCRIPTS].sort());
  });

  it.each(MINTING)("%s declares itself MINTS-AUTHORITY and DO NOT USE", (file) => {
    const s = flat(read(file).replace(/^\s*\*\s?/gm, ""));
    expect(s).toContain("MINTS-AUTHORITY");
    expect(s).toMatch(/DO NOT USE\. This script is NOT part of the interim admin-claim path/);
    expect(s).toMatch(/It is not a liveness probe of any kind/);
    for (const f of READ_ONLY_CHECKS) expect(s).toContain(f);
    // The header points at the ruled interim path, not at a Console action that does not exist.
    expect(s).toMatch(/set-system-admin-claim\.ts \(PR #295 at its exact reviewed commit f6039ea\) locally, dry run first/);
    expect(s).toMatch(/no Production run without separate authorization/);
    expect(s).not.toMatch(INTERIM_PATH_FORBIDDEN);
    // It must not point an operator at a tool that no longer exists.
    expect(s).not.toContain("probe-admin-secret");
    expect(s).not.toMatch(/ADMIN_SECRET/);
    expect(s).not.toMatch(/preferred over the bootstrap route/);
  });
});
