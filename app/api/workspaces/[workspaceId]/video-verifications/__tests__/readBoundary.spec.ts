/**
 * TEAM-VERIFICATION-PARITY-R5-I1 §AA/§AB — the structural read boundary.
 *
 * The Workspace Video GET shares a route FILE with the Production-stable Team
 * Video POST, so "the read path acquired a mutation dependency" is the failure
 * this suite is designed to catch at the SOURCE level, independently of any
 * runtime mock: the behavioural zero-side-effect proofs live in the three
 * route suites, and this one fails even if someone rewrites those mocks.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Comments explain what the code must NOT do, so they are stripped first. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const SHARED_ROUTE = "app/api/workspaces/[workspaceId]/video-verifications/route.ts";
const PROJECT_ROUTE = "app/api/workspaces/[workspaceId]/projects/[projectId]/video-verifications/route.ts";
const DETAIL_ROUTE = "app/api/workspaces/[workspaceId]/video-verifications/[verificationId]/route.ts";
const READ_LIBS = [
  "lib/workspaces/listTeamVideoVerifications.ts",
  "lib/workspaces/teamVideoVerificationSummary.ts",
  "lib/workspaces/teamVideoVerificationsCursor.ts",
  "lib/workspaces/teamVideoVerificationResponse.ts",
];

/** Everything the Team Video POST may do and a read may not. */
const MUTATION_DEPENDENCIES = [
  "executeVideoVerification",
  "checkAndIncrementUsageForRun",
  "saveTeamVideoVerification",
  "authorizeTeamVideoVerificationAdmission",
  "findTeamVideoVerificationDedupCandidate",
  "evaluateAndStoreGovernance",
  "incrementUserTokenUsage",
  "getEffectiveEntitlements",
  "getVideoLimit",
  "checkRateLimit",
  "analyzeMetadata",
];

/**
 * Firestore WRITE patterns. Deliberately anchored on a Firestore receiver
 * (`tx.`, a `…Ref`, a `.doc(...)`/`.collection(...)` chain) rather than a bare
 * `.set(` / `.add(`, which would also match an ordinary `Map`/`Set` used for
 * in-memory bookkeeping and make this suite fail for the wrong reason. The
 * positive control below proves the patterns still fire on real writer code.
 */
const WRITE_PATTERNS: Array<[string, RegExp]> = [
  ["transaction write (tx.set/update/delete/create)", /\btx\.(set|update|delete|create)\s*\(/],
  ["document-ref write (someRef.set/update/delete/create)", /Ref\.(set|update|delete|create)\s*\(/],
  ["inline doc write (.doc(...).set/update/delete/create)", /\.doc\([^)]*\)\s*\.(set|update|delete|create)\s*\(/],
  ["collection add (.collection(...).add)", /\.collection\([^)]*\)\s*\.add\s*\(/],
  ["runTransaction", /\brunTransaction\s*\(/],
  ["FieldValue sentinel or increment", /\bFieldValue\./],
  ["batched write", /\.batch\s*\(\)/],
  ["bulk writer", /\bbulkWriter\b/],
];
const WRITER_CONTROL = "lib/firestore/teamVideoVerifications.ts";

const GET_MARKER = "TEAM-VERIFICATION-PARITY-R5-I1 — GET: the durable Team Video verification";

describe("the shared route file's GET section", () => {
  const source = read(SHARED_ROUTE);
  const getSection = source.slice(source.indexOf(GET_MARKER));

  it("the GET section marker exists exactly once (this suite is not vacuous)", () => {
    expect(source.split(GET_MARKER)).toHaveLength(2);
    expect(getSection.length).toBeGreaterThan(500);
    expect(getSection).toContain("export async function GET");
  });

  it.each(MUTATION_DEPENDENCIES)("never references the POST-only dependency %s", (dep) => {
    expect(stripComments(getSection)).not.toContain(dep);
  });

  it.each(WRITE_PATTERNS)("never uses a Firestore write: %s", (_label, pattern) => {
    expect(stripComments(getSection)).not.toMatch(pattern);
  });

  it("does not read a request body", () => {
    for (const bodyRead of ["req.text()", "req.json()", "req.formData(", "req.arrayBuffer("]) {
      expect(stripComments(getSection)).not.toContain(bodyRead);
    }
  });

  it("POST is still exported and still owns its own pipeline (this PR added a handler, it did not rewrite one)", () => {
    expect(source).toContain("export async function POST");
    for (const dep of ["executeVideoVerification", "saveTeamVideoVerification", "checkAndIncrementUsageForRun", "checkRateLimit"]) {
      expect(source).toContain(dep);
    }
  });

  it("the GET section's CODE authorizes with research.read and never with a create capability, a role string or creator identity", () => {
    const code = stripComments(getSection);
    expect(code).toContain('access.capabilities.includes("research.read")');
    for (const forbidden of ["research.create", "research.organize", "membership.role", "userId"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe("the GET-only route files", () => {
  it.each([PROJECT_ROUTE, DETAIL_ROUTE])("%s exports GET and no mutating verb", (p) => {
    const source = read(p);
    expect(source).toContain("export async function GET");
    for (const verb of ["export async function POST", "export async function PUT", "export async function PATCH", "export async function DELETE"]) {
      expect(source).not.toContain(verb);
    }
  });

  it.each([PROJECT_ROUTE, DETAIL_ROUTE])("%s references no mutation dependency and no Firestore write API", (p) => {
    const source = stripComments(read(p));
    for (const dep of MUTATION_DEPENDENCIES) expect(source).not.toContain(dep);
    for (const [, pattern] of WRITE_PATTERNS) expect(source).not.toMatch(pattern);
  });

  it.each([PROJECT_ROUTE, DETAIL_ROUTE])("%s never filters or authorizes by creator/uploader identity", (p) => {
    const source = stripComments(read(p));
    for (const forbidden of ['"userId"', "uploaderId", "createdByUserId", "dedupRequester"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("the Team Video read libraries", () => {
  it.each(READ_LIBS)("%s contains no Firestore write API and no mutation dependency", (p) => {
    const source = stripComments(read(p));
    for (const [, pattern] of WRITE_PATTERNS) expect(source).not.toMatch(pattern);
    for (const dep of MUTATION_DEPENDENCIES) expect(source).not.toContain(dep);
  });

  it("the list helper queries only videoVerifications and never adds a creator predicate", () => {
    const source = read("lib/workspaces/listTeamVideoVerifications.ts");
    expect(source).toContain('db.collection("videoVerifications")');
    expect(source).not.toContain('where("userId"');
    expect(source).not.toContain('collection("verifications")');
  });
});

describe("Team read code never reaches for the Personal Video endpoint", () => {
  it.each([SHARED_ROUTE, PROJECT_ROUTE, DETAIL_ROUTE, ...READ_LIBS])("%s does not reference /api/verify-video or /api/user/", (p) => {
    const source = stripComments(read(p));
    expect(source).not.toContain("/api/verify-video");
    expect(source).not.toContain("/api/user/");
  });
});

describe("positive control — the write patterns are not vacuous", () => {
  const writer = stripComments(read(WRITER_CONTROL));

  it("the Team Video WRITER matches the transaction-write and FieldValue patterns this suite forbids in read code", () => {
    const matched = WRITE_PATTERNS.filter(([, pattern]) => pattern.test(writer)).map(([label]) => label);
    expect(matched).toEqual(expect.arrayContaining(["transaction write (tx.set/update/delete/create)", "FieldValue sentinel or increment"]));
  });

  it("the writer also references mutation dependencies the read paths must not", () => {
    expect(writer).toContain("saveTeamVideoVerification");
  });
});
