/**
 * THE BOOTSTRAP INVARIANT, REPOSITORY-WIDE — rewritten for security slice S1.
 *
 * History. `/api/admin/set-admin` validated a shared secret (`ADMIN_SECRET`,
 * "BOOTSTRAP_SECRET") BEFORE the uid, so a "check whether the old secret still
 * works" request carrying a uid silently MINTED `admin: true` — the verification
 * step became the breach. Phases C10–C17 policed that hazard with a uid-body
 * detector, a two-phase containment probe and an ordered BOOTSTRAP_* sequence.
 *
 * S1 deleted the route, the probe and the variable. While PR #295 was unmerged,
 * S1 documented an INTERIM path that pinned the hardened tool to a branch
 * checkout at its exact reviewed commit f6039ea. PR #295's merge replaced that:
 * the tool (`scripts/admin/set-system-admin-claim.ts`) is in the repository, and
 * the only documented path for an `admin` claim change is an OWNER action, never
 * an agent action — the tool run LOCALLY from a checkout of `main`, explicit
 * project and UID, dry run then typed confirmation, audit rows and
 * `--result-file` kept, exit codes read, no Production run without separate
 * authorization — verified with the read-only `scripts/check-admin-claims.js` /
 * `scripts/verify-admin-claims.js`. (Owner ruling OPTION B, 2026-11-09: the
 * Firebase Console cannot set custom claims or revoke refresh tokens.) PR #295
 * also DELETED the four legacy minting scripts; they must never return.
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
 *   P1. The post-merge admin-claim path is documented where an operator looks
 *       for it, with no current guidance anywhere describing #295 as pending
 *       or pointing at its branch, and the interim path kept as history in one
 *       marked, boundary-pinned paragraph.
 *   P2. Minting is found BY CONTENT, not by name: exactly one tracked script
 *       mints (the hardened tool), the four legacy scripts are absent, and in
 *       ALL tracked executable source only the hardened tool and the set-role
 *       route name `setCustomUserClaims` (compiler-parsed scan).
 *
 * This needs a real checkout: discovery uses `git ls-files`.
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as ts from "typescript";

const ROUTE = "/api/admin/set-admin";
const RUNBOOK = "docs/operations/admin-authority-tiers.md";
const LEGACY_SCRIPTS = [
  "scripts/setAdmin.ts",
  "scripts/set-admin-simple.js",
  "scripts/set-admin-by-uid.js",
  "scripts/set-admin-claim.js",
] as const;
const READ_ONLY_CHECKS = ["scripts/check-admin-claims.js", "scripts/verify-admin-claims.js"] as const;
const HARDENED_TOOL = "scripts/admin/set-system-admin-claim.ts";
const TOOL_RUNBOOK = "docs/operations/system-admin-claim-script.md";
const TOOL_LOGIC = ["lib/admin/systemAdminClaimSafety.ts", "lib/admin/systemAdminClaimExecution.ts"] as const;

const SKIP = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip|lock)$|^package-lock\.json$/i;
const TRACKED = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.includes("__tests__") && !f.includes("__fixtures__"))
  .filter((f) => !SKIP.test(f))
  .filter((f) => existsSync(f));

const read = (f: string) => readFileSync(f, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

/** Files classified HISTORICAL_RECORD in the manifest below (pinned there). */
const HISTORICAL_RECORDS = ["docs/operations/security-test-falsifiability.md"] as const;
const HISTORICAL_MARKER = /Superseded by security slice S1/;

// ─── TypeScript-compiler helpers (P2 executable scan, read-only verifiers) ──

const scriptKindOf = (f: string) =>
  f.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : f.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(f)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
const parseSource = (f: string, src: string) =>
  ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, scriptKindOf(f));
/** The file's code re-emitted by the compiler with every comment removed. */
const codeOf = (f: string, src: string) =>
  ts.createPrinter({ removeComments: true }).printFile(parseSource(f, src));
const walk = (node: ts.Node, visit: (n: ts.Node) => void) => {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
};

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
 * The admin-claim path after PR #295 merged (owner OPTION B, 2026-11-09, carried
 * forward). Every operator site must state each element; a site that reverts to
 * "owner action in the Firebase Console" (a path that does not exist), drops the
 * local-only rule, the dry run, the Production bar or the revocation limits, or
 * keeps a live "until #295 merges" instruction, fails here.
 */
const CLAIM_PATH_PINS: readonly RegExp[] = [
  /set-system-admin-claim/, //                       the tool, by name
  /locally\**,? from a (?:local )?checkout of `main`|local checkout of `main`/i, // local execution from main, as a phrase
  /rev-parse HEAD/, //                                the commit actually run is recorded
  /never from Vercel or any deployment/,
  /\bno defaults\b|Nothing is defaulted/i, //       explicit project and UID
  /--confirm-project/,
  /--target-uid/,
  /dry run first/i, //                              dry run before any executed claim
  /--confirm-claim/, //                                typed confirmation
  /--result-file/, //                                  evidence kept outside the repo
  /audit rows/,
  /No Production (?:grant or revoke|execution) without (?:its own )?separate authorization/,
  /never an agent action/i,
  /effectiveRevocation: "not_observable"/, //          revocation is requested, never observed
  /\bS2(?:-b)? is not live\b/, //                       the bearer-path window is still open
];
/** Wording that is wrong once #295 has merged, or never described a path. */
const CLAIM_PATH_FORBIDDEN: readonly RegExp[] = [
  /owner action in the Firebase Console/i,
  /\buntil (?:the hardened operator CLI )?\(?(?:PR )?#295\)? merges\b/i,
  /reviewed and approved but unmerged/i,
  /merge stays gated on S2/i,
  /on that branch describes/i,
  /must print `f6039eaecb659159f52019b7f4cff4cce6a4ed89`/, // present-tense pin to the pre-merge commit
  /\bThis is (?:an )?interim\b/i,
];

/**
 * Current guidance that still treats #295 as pending, awaiting merge or not
 * integrated, or that sends an operator to its branch. Broader than
 * CLAIM_PATH_FORBIDDEN (which lists the exact old sentences): any phrasing of
 * that shape fails, wherever it appears in a tracked non-test file, EXCEPT inside
 * the explicitly marked history region (see currentGuidance below). Past-tense
 * history ("Before PR #295 merged, ...", "PR #295's merge replaced ...") passes.
 */
const PENDING_295: readonly RegExp[] = [
  /\b(?:until|pending|awaiting|once|before)\b[^.]{0,60}#295\b(?!\)?\s+(?:merged|was merged|had (?:been )?merged)\b|['’]s merge (?:replaced|landed)\b)/i,
  /#295\b[^.]{0,40}\b(?:is|remains|stays|still)\s+(?:not\s+(?:yet\s+)?(?:merged|integrated|landed)|unmerged|open|pending|in review|awaiting)\b/i,
  /\bnot (?:yet )?(?:merged|integrated)\b[^.]{0,40}#295\b/i,
  /\bfix\/admin-claim-script-hardening\b/,
  /\bfrom (?:the |its )(?:(?:PR )?#295 |PR |pre-merge |feature )?branch\b|\bfrom branch\b/i,
];

/**
 * The ONLY exemption from PENDING_295 inside a current-guidance file: the marked
 * history paragraph of the runbook, located by BOTH of its pinned boundaries.
 * Each boundary must occur exactly once, in order, and bound a region of
 * plausible size; otherwise this throws, so a moved or deleted marker cannot
 * silently widen the exemption to the whole file. Files classified
 * HISTORICAL_RECORD are exempt whole only while they carry the S1 marker.
 */
const HISTORY_START = "**History: the S1 interim path (PR #299).**";
const HISTORY_END = "This paragraph is history, not an instruction.";
const HISTORY_MAX_CHARS = 1500;
function currentGuidance(file: string, text: string): string {
  const s = flat(text);
  if ((HISTORICAL_RECORDS as readonly string[]).includes(file) && HISTORICAL_MARKER.test(s)) return "";
  if (file !== RUNBOOK) return s;
  const start = s.indexOf(HISTORY_START);
  const end = s.indexOf(HISTORY_END);
  const once = (m: string, at: number) => at !== -1 && s.indexOf(m, at + 1) === -1;
  if (!once(HISTORY_START, start) || !once(HISTORY_END, end) || end < start || end - start > HISTORY_MAX_CHARS) {
    throw new Error(`${file}: the marked history region is not bounded by exactly one start and one end marker`);
  }
  return s.slice(0, start) + s.slice(end + HISTORY_END.length);
}
const pendingMergeHits = (file: string, text: string) => {
  const s = currentGuidance(file, text);
  return PENDING_295.filter((re) => re.test(s)).map((re) => `${file}: ${re}`);
};

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
    | "HARDENED_MINTING_TOOL"; // invocation rule + P2 hardened-tool header contract

  const MANIFEST: Record<string, Kind> = {
    "CLAUDE.md": "OPERATOR_INSTRUCTION",
    "README.md": "OPERATOR_INSTRUCTION",
    "docs/operations/admin-authority-tiers.md": "OPERATOR_INSTRUCTION",
    "docs/technical-documentation.md": "OPERATOR_INSTRUCTION",
    "docs/operations/security-test-falsifiability.md": "HISTORICAL_RECORD",
    "docs/operations/firebase-environment-isolation.md": "INVENTORY",
    // PR #295: the tool's runbook names the removed scripts (as removed).
    "docs/operations/system-admin-claim-script.md": "OPERATOR_INSTRUCTION",
    "lib/security/rateLimit.ts": "IMPLEMENTATION",
    // Comments explaining which retired-script defects a guard closes.
    "lib/admin/systemAdminClaimSafety.ts": "IMPLEMENTATION",
    // PR #295 deleted the three legacy MINTING_EXAMPLE entries; the hardened
    // tool replaces them under its own contract (P2).
    "scripts/admin/set-system-admin-claim.ts": "HARDENED_MINTING_TOOL",
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

  it("the historical-record site list is itself pinned (it is exempt from PENDING_295)", () => {
    expect(sitesOf("HISTORICAL_RECORD")).toEqual([...HISTORICAL_RECORDS]);
  });

  it("the operator-instruction site list is itself pinned", () => {
    expect(sitesOf("OPERATOR_INSTRUCTION")).toEqual([
      "CLAUDE.md",
      "README.md",
      "docs/operations/admin-authority-tiers.md",
      "docs/operations/system-admin-claim-script.md",
      "docs/technical-documentation.md",
    ]);
  });

  it.each(sitesOf("OPERATOR_INSTRUCTION"))(
    "N1 %s: every mention of the retired route, secret, probe or a legacy script negates it",
    (file) => {
      expect({ file, recommends: recommendations(read(file)) }).toEqual({ file, recommends: [] });
    }
  );

  it.each(sitesOf("OPERATOR_INSTRUCTION", "HISTORICAL_RECORD", "INVENTORY", "IMPLEMENTATION", "HARDENED_MINTING_TOOL"))(
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

// ─── the admin-claim path (post-#295) ───────────────────────────────────────

describe("P1 — the post-merge admin-claim path is documented where operators look", () => {
  const src = read(RUNBOOK);
  const HEADING = "### Changing the `admin` claim — the SYSTEM_ADMIN claim operator tool";
  const section = src.slice(src.indexOf(HEADING), src.indexOf("### Password admin session"));
  const HISTORY = "**History: the S1 interim path (PR #299).**";
  /** The instruction part of the section: everything before the history paragraph. */
  const instruction = section.slice(0, section.indexOf(HISTORY));
  const history = section.slice(section.indexOf(HISTORY));

  it("ANCHOR: the section, its instruction part and its history paragraph were located", () => {
    expect(src.indexOf(HEADING)).toBeGreaterThan(-1);
    expect(section.length).toBeGreaterThan(3000);
    expect(section.indexOf(HISTORY)).toBeGreaterThan(2000);
    expect(history.length).toBeGreaterThan(400);
    // The retired interim heading is gone.
    expect(src).not.toContain("### Interim path for an `admin` claim change");
  });

  it("the tool, its logic and its runbook are tracked in this repository", () => {
    for (const f of [HARDENED_TOOL, ...TOOL_LOGIC, TOOL_RUNBOOK, ...READ_ONLY_CHECKS]) {
      expect({ f, tracked: TRACKED.includes(f) }).toEqual({ f, tracked: true });
    }
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["admin:set-system-admin-claim"]).toContain(HARDENED_TOOL);
  });

  it("names the owner and the local operator tool, and forbids agent and Console execution", () => {
    const s = flat(instruction);
    expect(s).toMatch(
      /\*\*owner action, run locally with the reviewed SYSTEM_ADMIN claim operator tool\*\*\. It is never an agent action/
    );
    expect(s).toMatch(/Change only the `admin` key/);
    for (const re of CLAIM_PATH_FORBIDDEN) expect({ re: String(re), hit: re.test(s) }).toEqual({ re: String(re), hit: false });
    for (const re of CLAIM_PATH_PINS) expect({ re: String(re), hit: re.test(s) }).toEqual({ re: String(re), hit: true });
  });

  it("the instruction part runs the tool from main, not from the pre-merge branch or commit", () => {
    const s = flat(instruction);
    expect(s).toMatch(/\*\*Local checkout of `main`, clean, recorded\.\*\* Run the tool from a local checkout of `main` and nothing else/);
    expect(s).toMatch(/`--execute` refuses while `scripts\/admin` or `lib\/admin` has uncommitted changes/);
    expect(s).not.toContain("fix/admin-claim-script-hardening");
    expect(s).not.toContain("f6039ea");
  });

  it("states dry run, typed confirmation, the Production bar and the revocation no-call cases", () => {
    const s = flat(instruction);
    expect(s).toMatch(/\*\*Dry run first, then typed confirmation\.\*\* Without `--execute` the tool/);
    expect(s).toMatch(/\*\*No Production execution without separate authorization\.\*\* Each Production grant or revoke needs its own explicit owner authorization naming the operation, the project and the UID/);
    // Step 4's revocation sentence must keep the no-call cases (review N1 of 0d1e854).
    expect(s).toMatch(/requests refresh-token revocation unless the fresh read immediately before the call/);
    expect(s).not.toMatch(/Every executed revoke requests refresh-token revocation\./);
  });

  it("states how to handle an incomplete run: every exit code, precedence, never a no-op", () => {
    const s = flat(instruction);
    expect(s).toMatch(/\*\*Read the exit code; an incomplete run is not a no-op\.\*\*/);
    expect(s).toMatch(/`2` refused or dry run: no Firebase write call was issued/);
    expect(s).toMatch(/`3` a write call was issued \(possibly only the attempt audit row\) and the operation is incomplete/);
    expect(s).toMatch(/a revoke re-run calls `revokeRefreshTokens` again, which overwrites `validSince`/);
    expect(s).toMatch(/`4` review required: do not re-run blindly/);
    expect(s).toMatch(/`1` the result file could not be written after an otherwise exit-0 run/);
    expect(s).toMatch(/Precedence is 3 > 4 > 0/);
  });

  it("states the revocation limits: not observable, and S2-b not live", () => {
    const s = flat(instruction);
    expect(s).toMatch(/effective revocation is never observable by the tool \(`effectiveRevocation: "not_observable"`\)/);
    expect(s).toMatch(/\*\*What remains open: S2 is not live\.\*\*/);
    expect(s).toMatch(/Revocation checking on those bearer paths is S2 \(S2-b\), and S2-b is not live/);
    expect(s).toMatch(/an already-issued ID token keeps `admin: true` for up to about an hour/);
  });

  it("verification is the read-only checks", () => {
    for (const f of READ_ONLY_CHECKS) expect(instruction).toContain(f);
  });

  it("names every legacy minting script inside a removed-never-restore passage", () => {
    const s = flat(instruction);
    const start = s.indexOf("**The legacy minting scripts were removed and must never be restored:**");
    expect(start).toBeGreaterThan(-1);
    const passage = s.slice(start, start + 600);
    for (const f of LEGACY_SCRIPTS) expect(passage).toContain(f);
    expect(s).toMatch(/do not add any other script that calls `setCustomUserClaims`/);
  });

  it("keeps the S1 interim path as HISTORY: branch, exact commit, and that it was superseded", () => {
    const h = flat(history);
    expect(h).toMatch(/Before PR #295 merged, the tool existed only on branch `fix\/admin-claim-script-hardening`/);
    expect(h).toMatch(/exact reviewed commit `f6039ea`/);
    expect(h).toContain("f6039eaecb659159f52019b7f4cff4cce6a4ed89");
    expect(h).toMatch(/The merge of PR #295 replaced that interim path with this section/);
    expect(h).toMatch(/This paragraph is history, not an instruction\./);
  });

  it.each(["CLAUDE.md", "README.md", "docs/technical-documentation.md"])(
    "%s states the same post-merge path",
    (f) => {
      const s = flat(read(f));
      expect(s).toMatch(/owner action\**,? never an agent action/);
      for (const re of CLAIM_PATH_FORBIDDEN) expect({ f, re: String(re), hit: re.test(s) }).toEqual({ f, re: String(re), hit: false });
      for (const re of CLAIM_PATH_PINS) expect({ f, re: String(re), hit: re.test(s) }).toEqual({ f, re: String(re), hit: true });
      expect(s).toContain("scripts/check-admin-claims.js");
      expect(s).toMatch(/not\** part of (that|this) path/);
      expect(s).toMatch(/never restore them/i);
    }
  );

  it("CLAUDE.md keeps why the legacy scripts were unsafe, what the tool preserves, and who may run it", () => {
    const s = flat(read("CLAUDE.md"));
    expect(s).toMatch(/were removed and are not part of that path; never restore them\./);
    expect(s).toMatch(
      /They were unsafe: they could overwrite the account's existing custom claims or mishandle the `admin` claim value\./
    );
    expect(s).toMatch(/The hardened operator tool changes only the `admin` custom-claim key and preserves unrelated claims\./);
    expect(s).toMatch(/An `admin` claim change is an owner action, never an agent action/);
    expect(s).toMatch(/No agent may run it or make any other unapproved privileged mutation: it is owner-only\./);
  });

  it("no tracked non-test file keeps a live interim instruction", () => {
    const hits = TRACKED.filter((f) => /\.(md|ts|tsx|js|mjs|cjs)$/.test(f))
      .flatMap((f) => CLAIM_PATH_FORBIDDEN.filter((re) => re.test(flat(read(f)))).map((re) => `${f}: ${re}`));
    expect(hits).toEqual([]);
  });

  it("SELF-VALIDATION: the forbidden-wording list catches the pre-merge sentences", () => {
    for (const bad of [
      "Until the hardened operator CLI (PR #295) merges, an emergency `admin` claim change is an owner action.",
      "until #295 merges",
      "PR #295 is reviewed and approved but unmerged; its merge stays gated on S2.",
      "exactly as `docs/operations/system-admin-claim-script.md` on that branch describes.",
      "`git -C <checkout> rev-parse HEAD` must print `f6039eaecb659159f52019b7f4cff4cce6a4ed89`",
      "This is interim: #295 is reviewed.",
    ]) {
      expect({ bad, caught: CLAIM_PATH_FORBIDDEN.some((re) => re.test(bad)) }).toEqual({ bad, caught: true });
    }
    for (const ok of [
      "Before PR #295 merged, the tool existed only on branch `fix/admin-claim-script-hardening`.",
      "(`git -C <checkout> rev-parse HEAD` had to print `f6039eaecb659159f52019b7f4cff4cce6a4ed89`)",
    ]) {
      expect({ ok, caught: CLAIM_PATH_FORBIDDEN.some((re) => re.test(ok)) }).toEqual({ ok, caught: false });
    }
  });

  it("no tracked non-test file describes #295 as pending or sends anyone to its branch", () => {
    const files = TRACKED.filter((f) => !/\.(spec|test)\.[cm]?[jt]sx?$/.test(f));
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(expect.arrayContaining(["CLAUDE.md", "README.md", RUNBOOK, "docs/technical-documentation.md"]));
    expect(files.flatMap((f) => pendingMergeHits(f, read(f)))).toEqual([]);
  });

  it("ANCHOR: the runbook's marked history region is bounded, small, and the only part exempted", () => {
    const s = flat(src);
    const start = s.indexOf(HISTORY_START);
    const end = s.indexOf(HISTORY_END);
    expect(start).toBeGreaterThan(-1);
    expect(end - start).toBeGreaterThan(400);
    expect(end - start).toBeLessThan(HISTORY_MAX_CHARS);
    // The real history region does contain wording PENDING_295 would flag.
    expect(PENDING_295.some((re) => re.test(s.slice(start, end)))).toBe(true);
    // Only that region is removed: the instruction part survives intact.
    expect(currentGuidance(RUNBOOK, src)).toContain("**Local checkout of `main`, clean, recorded.**");
    expect(currentGuidance(RUNBOOK, src).length).toBeGreaterThan(s.length - HISTORY_MAX_CHARS - HISTORY_END.length);
  });

  it("SELF-VALIDATION: PENDING_295 catches pending-merge guidance and spares marked history", () => {
    const variants = [
      "Until PR #295 is merged, run the tool from the branch.",
      "The operator tool (pending #295; run it from branch fix/admin-claim-script-hardening) is the only path.",
    ];
    // Positive: both surviving variants are detected in a current-guidance doc,
    // and in the runbook OUTSIDE its marked history region.
    for (const v of variants) {
      const doc = `## Admin claims\n\nThe owner runs the tool locally. ${v} Keep the audit rows.\n`;
      expect({ v, hits: pendingMergeHits("README.md", doc).length > 0 }).toEqual({ v, hits: true });
      const runbook = `Intro. ${v} More.\n\n${HISTORY_START} Old text. ${HISTORY_END}\n`;
      expect({ v, hits: pendingMergeHits(RUNBOOK, runbook).length > 0 }).toEqual({ v, hits: true });
    }
    for (const bad of [
      "Once #295 merges, switch to main.",
      "Awaiting merge of PR #295, use the branch checkout.",
      "PR #295 is not yet merged.",
      "This is not yet integrated (#295).",
      "Run it from the PR branch.",
      "Run it from the #295 branch.",
    ]) {
      expect({ bad, hits: pendingMergeHits("README.md", bad).length > 0 }).toEqual({ bad, hits: true });
    }
    // Negative: the same wording inside the marked history paragraph passes.
    for (const v of variants) {
      const runbook = `Intro.\n\n${HISTORY_START} Back then: ${v} ${HISTORY_END}\n\nOutro.`;
      expect({ v, hits: pendingMergeHits(RUNBOOK, runbook) }).toEqual({ v, hits: [] });
    }
    // Negative: legitimate past-tense mentions of #295 outside any history region.
    for (const ok of [
      "PR #295 deleted them (S1 had scheduled that deletion for security slice S5).",
      "Before PR #295 merged, an S1 interim path ran the tool from a branch checkout at commit `f6039ea`; that is history.",
      "Before #295 merged, an S1 interim path pinned the tool to a branch checkout at commit `f6039ea`; that is history now.",
      "PR #295's merge replaced that interim path.",
    ]) {
      expect({ ok, hits: pendingMergeHits("README.md", ok) }).toEqual({ ok, hits: [] });
    }
    // HISTORICAL_RECORD files are exempt only while they carry the S1 marker.
    expect(pendingMergeHits(HISTORICAL_RECORDS[0], `> Superseded by security slice S1. ${variants[0]}`)).toEqual([]);
    expect(pendingMergeHits(HISTORICAL_RECORDS[0], variants[0]).length).toBeGreaterThan(0);
  });

  it("SELF-VALIDATION: the history exemption fails closed when its boundaries are not pinned", () => {
    const body = "Until PR #295 is merged, run the tool from the branch.";
    for (const broken of [
      `${HISTORY_START} ${body}`, //                                 no end marker
      `${body} ${HISTORY_END}`, //                                    no start marker
      `${HISTORY_END} ${body} ${HISTORY_START}`, //                   reversed
      `${HISTORY_START} a ${HISTORY_END} ${HISTORY_START} ${body} ${HISTORY_END}`, // duplicated
      `${HISTORY_START} ${"x ".repeat(HISTORY_MAX_CHARS)} ${body} ${HISTORY_END}`, // oversized
    ]) {
      expect(() => pendingMergeHits(RUNBOOK, broken)).toThrow(/marked history region/);
    }
  });

  /**
   * The read-only verifiers, checked through the TypeScript compiler. A write
   * reached dynamically (a computed method name, `import()`, `createRequire`,
   * `eval`, `Function(`) would evade the literal write list, so those shapes are
   * forbidden too; check-admin-claims.js keeps a pinned set of element accesses
   * on its own local argument/env objects, and any other computed access fails.
   */
  const ALIAS_BODY = [
    `const { runAsCli } = require("./check-admin-claims.js");`,
    `if (require.main === module) {`,
    `    runAsCli(process.argv.slice(2), process.env);`,
    `}`,
    ``,
  ].join("\n");
  const CHECKER_ELEMENT_ACCESSES = [
    `env[k]`,
    `values["--confirm-project"]`,
    `values["--confirm-project"]`,
    `values["--credentials"]`,
    `values["--uid"]`,
    `values["--uid"]`,
    `values[name]`,
  ];
  const CHECKER_REQUIRES = [`node:fs`, `node:path`, `firebase-admin/app`, `firebase-admin/auth`];

  function readOnlyFindings(f: string, src: string) {
    const sf = parseSource(f, src);
    const code = codeOf(f, src);
    const elementAccesses: string[] = [];
    const requires: string[] = [];
    const dynamic: string[] = [];
    walk(sf, (n) => {
      if (ts.isElementAccessExpression(n)) elementAccesses.push(n.getText(sf));
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic.push("import()");
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) dynamic.push("import declaration");
      if (ts.isIdentifier(n) && ["createRequire", "eval", "Function"].includes(n.text)) dynamic.push(n.text);
      // `require` only as a direct call or as `require.main`: an alias would hide what it loads.
      if (ts.isIdentifier(n) && n.text === "require") {
        const p = n.parent;
        const direct = ts.isCallExpression(p) && p.expression === n;
        const main = ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === "main";
        if (!direct && !main) dynamic.push("require alias");
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") {
        const a = n.arguments[0];
        requires.push(n.arguments.length === 1 && ts.isStringLiteral(a) ? a.text : `<non-literal require: ${n.getText(sf)}>`);
      }
    });
    // Lexical fallback over the comment-free code, for shapes the walk misses.
    for (const m of code.match(/\bimport\s*\(|\bcreateRequire\b|\beval\b|\bFunction\s*\(/g) ?? []) dynamic.push(`lexical ${m}`);
    const writes = code.match(/setCustomUserClaims|revokeRefreshTokens|updateUser|deleteUser|createUser|\.set\(|\.update\(|\.delete\(/g) ?? [];
    return { code, elementAccesses: elementAccesses.sort(), requires, dynamic, writes };
  }

  it("the read-only checks really are read-only", () => {
    const [checker, alias] = READ_ONLY_CHECKS;
    const c = readOnlyFindings(checker, read(checker));
    expect(c.code).toMatch(/getUser\(/);
    expect({ writes: c.writes, dynamic: c.dynamic }).toEqual({ writes: [], dynamic: [] });
    expect(c.elementAccesses).toEqual(CHECKER_ELEMENT_ACCESSES);
    expect(c.requires).toEqual(CHECKER_REQUIRES);

    // PR #295 made verify-admin-claims.js a thin alias for check-admin-claims.js:
    // its whole comment-free body is pinned, so it can load or do nothing else.
    const a = readOnlyFindings(alias, read(alias));
    expect(a.code).toBe(ALIAS_BODY);
    expect({ writes: a.writes, dynamic: a.dynamic, elementAccesses: a.elementAccesses, requires: a.requires }).toEqual({
      writes: [],
      dynamic: [],
      elementAccesses: [],
      requires: ["./check-admin-claims.js"],
    });
  });

  it("SELF-VALIDATION: the read-only findings catch dynamic and computed writes", () => {
    const base = `const { getAuth } = require("firebase-admin/auth");\nconst u = await getAuth().getUser(uid);\n`;
    expect(readOnlyFindings("x.js", base)).toMatchObject({ writes: [], dynamic: [], elementAccesses: [] });
    expect(readOnlyFindings("x.js", `${base}const m = await import("firebase-admin/auth"); m.getAuth().x(uid);`).dynamic).toContain("import()");
    expect(readOnlyFindings("x.js", `${base}getAuth()["set" + "CustomUserClaims"](uid, {});`).elementAccesses).toHaveLength(1);
    expect(readOnlyFindings("x.js", `${base}const { createRequire } = require("node:module"); createRequire(__filename)("x");`).dynamic).toContain("createRequire");
    expect(readOnlyFindings("x.js", `${base}eval("getAuth().x()");`).dynamic).toContain("eval");
    expect(readOnlyFindings("x.js", `${base}new Function("return 1")();`).dynamic).toContain("Function");
    expect(readOnlyFindings("x.js", `${base}const r = require; r(name);`).dynamic).toContain("require alias");
    expect(readOnlyFindings("x.js", `${base}require(name);`).requires[1]).toMatch(/non-literal require/);
    // A comment mentioning these shapes is not code.
    expect(readOnlyFindings("x.js", `${base}// eval import( createRequire Function( setCustomUserClaims`)).toMatchObject({ writes: [], dynamic: [] });
  });
});

// ─── minting scripts, by content ────────────────────────────────────────────

describe("P2 — admin-minting scripts are found BY CONTENT; only the hardened tool mints", () => {
  /**
   * Phase C12 lesson kept: `scripts/setAdmin.ts` once escaped a filename glob,
   * so minting is detected by content. Phase ADMIN-SCRIPT-HARDENING (PR #295)
   * broadened the predicate: ANY `setCustomUserClaims(` call counts, whatever
   * its claim argument, because the hardened tool writes a computed object
   * (`plan.after`, built in lib/admin) that the old `admin: true` literal match
   * would miss. Every literal form the old predicate caught still contains the
   * call. A reference to the retired route alongside a uid still counts.
   */
  const SCRIPT_FILES = TRACKED.filter((f) => /^scripts\//.test(f) && /\.(js|cjs|mjs|ts|tsx)$/.test(f));

  const mintsAuthority = (src: string) => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const setsClaim = /setCustomUserClaims\s*\(/.test(code);
    const postsUidToBootstrap = code.includes(ROUTE) && /\buid\b/i.test(code);
    return setsClaim || postsUidToBootstrap;
  };

  const MINTING = SCRIPT_FILES.filter((f) => mintsAuthority(read(f)));

  it("SELF-VALIDATION: the predicate catches a minting script under any name", () => {
    expect(mintsAuthority(`await adminAuth.setCustomUserClaims(uid, { admin: true });`)).toBe(true);
    expect(mintsAuthority(`const admin = true; await setCustomUserClaims(uid, { admin });`)).toBe(true);
    expect(mintsAuthority(`await setCustomUserClaims(uid, { "admin": true });`)).toBe(true);
    // A computed claim object (the hardened tool's form) is still minting.
    expect(mintsAuthority(`await auth.setCustomUserClaims(uid, plan.after);`)).toBe(true);
    expect(mintsAuthority(`await fetch("https://x.test/api/admin/set-admin", { body: JSON.stringify({ uid, secret }) });`)).toBe(true);
    expect(mintsAuthority(`// this script does not call setCustomUserClaims with admin: true`)).toBe(false);
    expect(mintsAuthority(`const u = await auth.getUser(uid); console.log(u.customClaims);`)).toBe(false);
  });

  it("ANCHOR: the content scan finds exactly one minting tool — the hardened one", () => {
    expect(SCRIPT_FILES.length).toBeGreaterThan(5);
    // Exact, not arrayContaining: a second minting script anywhere under
    // scripts/ must be a deliberate, reviewed change to this list.
    expect(MINTING).toEqual([HARDENED_TOOL]);
  });

  /**
   * Repository-wide: every tracked executable source file (not only scripts/),
   * parsed with the TypeScript compiler. A file is a claim writer if its syntax
   * tree names `setCustomUserClaims` as an identifier or property (direct and
   * aliased calls, destructuring, `const f = auth.setCustomUserClaims`, `.bind(`,
   * re-exporting wrappers) or as a string literal (`auth["setCustomUserClaims"]`),
   * or if its comment-free code contains the name anywhere (lexical fallback).
   *
   * LIMIT: a lexical or syntax-tree scan cannot prove the ABSENCE of a call whose
   * name is constructed at run time ("setCustom" + "UserClaims", decoded strings,
   * reflection over the Auth prototype). It catches every spelled-out form; the
   * rest is left to review.
   */
  const CLAIM_WRITER = "setCustomUserClaims";
  const SET_ROLE = "app/api/admin/set-role/route.ts";
  /** Exact: the hardened tool and the SYSTEM_ADMIN set-role route (which calls it directly). */
  const CLAIM_WRITER_ALLOW_LIST = [SET_ROLE, HARDENED_TOOL].sort();
  const isTestFile = (f: string) => /(^|\/)(__tests__|__fixtures__|__mocks__)\/|\.(spec|test)\.[cm]?[jt]sx?$/.test(f);
  const EXECUTABLE_SOURCE = TRACKED.filter(
    (f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts") && !isTestFile(f) && !f.includes("node_modules/")
  );

  function claimWriterEvidence(f: string, src: string) {
    const sf = parseSource(f, src);
    const evidence: string[] = [];
    let calls = 0;
    walk(sf, (n) => {
      if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && n.text === CLAIM_WRITER) evidence.push("identifier");
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === CLAIM_WRITER) evidence.push("string");
      if (ts.isCallExpression(n)) {
        let callee: ts.Expression = n.expression;
        while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
        const named =
          (ts.isPropertyAccessExpression(callee) && callee.name.text === CLAIM_WRITER) ||
          (ts.isElementAccessExpression(callee) &&
            ts.isStringLiteralLike(callee.argumentExpression) &&
            callee.argumentExpression.text === CLAIM_WRITER) ||
          (ts.isIdentifier(callee) && callee.text === CLAIM_WRITER);
        if (named) calls++;
      }
    });
    if (codeOf(f, src).includes(CLAIM_WRITER)) evidence.push("lexical");
    return { writes: evidence.length > 0, evidence, calls };
  }

  it("SELF-VALIDATION: the claim-writer scan catches every spelled-out form, not comments", () => {
    for (const [f, bad] of [
      ["a.ts", `await auth.setCustomUserClaims(uid, { admin: true });`],
      ["a.ts", `await getAuth().setCustomUserClaims(uid, c);`],
      ["a.ts", `const { setCustomUserClaims } = auth; await setCustomUserClaims(uid, c);`],
      ["a.ts", `const { setCustomUserClaims: put } = getAuth(); await put(uid, c);`],
      ["a.ts", `const f = auth.setCustomUserClaims; await f.call(auth, uid, c);`],
      ["a.ts", `await auth["setCustomUserClaims"](uid, c);`],
      ["a.ts", "await auth[`setCustomUserClaims`](uid, c);"],
      ["a.ts", `const m = ["setCustomUserClaims"]; await auth[m[0]](uid, c);`],
      ["a.ts", `const w = auth.setCustomUserClaims.bind(auth); await w(uid, c);`],
      ["a.mjs", `export const write = (u, c) => getAuth().setCustomUserClaims(u, c);`],
      ["a.js", `module.exports = { put: getAuth().setCustomUserClaims.bind(getAuth()) };`],
      ["a.tsx", `const B = () => <button onClick={() => auth.setCustomUserClaims(u, c)} />;`],
      ["a.ts", "const name = `x${1}setCustomUserClaims`;"],
    ] as const) {
      expect({ bad, writes: claimWriterEvidence(f, bad).writes }).toEqual({ bad, writes: true });
    }
    for (const ok of [
      `// do not call setCustomUserClaims here`,
      `/* setCustomUserClaims is SYSTEM_ADMIN only */ const u = await auth.getUser(uid);`,
      `const claims = user.customClaims ?? {};`,
    ]) {
      expect({ ok, writes: claimWriterEvidence("a.ts", ok).writes }).toEqual({ ok, writes: false });
    }
    expect(claimWriterEvidence("a.ts", `await auth.setCustomUserClaims(uid, c);`).calls).toBe(1);
    expect(claimWriterEvidence("a.ts", `await auth["setCustomUserClaims"](uid, c);`).calls).toBe(1);
    expect(claimWriterEvidence("a.ts", `const f = auth.setCustomUserClaims;`).calls).toBe(0);
  });

  it("ANCHOR: the executable-source scan covers every tracked source directory", () => {
    expect(EXECUTABLE_SOURCE.length).toBeGreaterThan(800);
    for (const dir of ["app/", "lib/", "scripts/", "components/", "hooks/"]) {
      expect({ dir, files: EXECUTABLE_SOURCE.some((f) => f.startsWith(dir)) }).toEqual({ dir, files: true });
    }
    for (const f of ["middleware.ts", "next.config.js", SET_ROLE, HARDENED_TOOL]) expect(EXECUTABLE_SOURCE).toContain(f);
    expect(EXECUTABLE_SOURCE.filter(isTestFile)).toEqual([]);
  });

  it("only the allow-listed files write custom claims, anywhere in tracked executable source", () => {
    const writers = EXECUTABLE_SOURCE.filter((f) => claimWriterEvidence(f, read(f)).writes).sort();
    expect(writers).toEqual(CLAIM_WRITER_ALLOW_LIST);
  });

  it("each allow-listed file still calls setCustomUserClaims (identified, not silently excluded)", () => {
    for (const f of CLAIM_WRITER_ALLOW_LIST) {
      expect({ f, calls: claimWriterEvidence(f, read(f)).calls >= 1 }).toEqual({ f, calls: true });
    }
    // set-role makes the call itself, behind its SYSTEM_ADMIN gate; no lib helper does it for it.
    const route = codeOf(SET_ROLE, read(SET_ROLE));
    expect(route).toMatch(/await adminAuth\.setCustomUserClaims\(uid, customClaims\)/);
    expect(route).toMatch(/await requireSystemAdminBearer\(request\)/);
  });

  it("the four legacy minting scripts are absent from the tree, not merely unclassified", () => {
    for (const f of LEGACY_SCRIPTS) {
      expect({ f, tracked: TRACKED.includes(f), exists: existsSync(f) }).toEqual({ f, tracked: false, exists: false });
    }
  });

  it("the hardened tool declares itself MINTS-AUTHORITY and states its safeguards", () => {
    const raw = read(HARDENED_TOOL);
    // The header is the file's leading block comment.
    expect(raw.startsWith("/**")).toBe(true);
    const header = flat(raw.slice(0, raw.indexOf("*/") + 2).replace(/^\s*\*\s?/gm, ""));
    expect(header.length).toBeGreaterThan(1500);
    expect(header).not.toMatch(/ADMIN_SECRET|BOOTSTRAP_SECRET|\/api\/admin\/set-admin/);
    expect({ recommends: recommendations(header) }).toEqual({ recommends: [] });
    expect(header).toMatch(/deployments built before S1 still ship the route, and their retirement is security step SEC-7/);
    expect(header).not.toMatch(/no secret rotation left to verify/);
    const s = flat(raw.replace(/^\s*\*\s?/gm, ""));
    expect(s).toContain("MINTS-AUTHORITY");
    expect(s).toMatch(/never a secret-liveness probe/);
    expect(s).toMatch(/dry run is the default; nothing is written without --execute/);
    expect(s).toContain("--confirm-project=<projectId>");
    expect(s).toContain("--target-uid=<uid>");
    expect(s).toContain("--confirm-claim=<exact string printed by the dry run>");
    expect(s).toContain(TOOL_RUNBOOK);
    expect(s).toMatch(/It replaces the retired scripts\/setAdmin\.ts/);
    // Main's S1 deleted the probe and the Option 1/Option 2 enrollment split;
    // the header must not point an operator at either.
    expect(s).not.toContain("probe-admin-secret");
    expect(s).not.toMatch(/Option 1/);
    expect(s).toMatch(/retired in security slice S1/);
    for (const re of CLAIM_PATH_FORBIDDEN) expect({ re: String(re), hit: re.test(s) }).toEqual({ re: String(re), hit: false });
  });
});
