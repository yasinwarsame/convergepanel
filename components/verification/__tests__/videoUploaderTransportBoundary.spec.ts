/**
 * TEAM-VERIFICATION-PARITY-R5-I3-A §U — the transport boundary, asserted at the
 * SOURCE level so the split stays mechanically reviewable.
 *
 * The shared surface must name no endpoint and no identity; the Personal
 * wrapper must own exactly one endpoint and must never reach a Team one. In
 * R5-I3-B a Team wrapper joins this file with the mirrored assertion, at which
 * point "Team never posts to /api/verify-video" is one line rather than a
 * review convention.
 */

import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments describe what the code must NOT do, so they are stripped first. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const SURFACE = "components/verification/VideoUploaderSurface.tsx";
const CONTRACT = "lib/verification/videoUploadClientContract.ts";
const PERSONAL = "components/VideoUploader.tsx";

describe("the shared surface is transport-neutral", () => {
  const code = stripComments(read(SURFACE));

  it.each([
    "/api/verify-video",
    "/api/workspaces",
    "/api/user/",
    "authedFetch",
    "getIdToken",
    "Authorization",
    "workspaceId",
    "projectId",
    "useAuth",
    "firebase",
  ])("names no %s", (forbidden) => {
    expect(code).not.toContain(forbidden);
  });

  it("issues no network call of its own", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("XMLHttpRequest");
  });

  it("reaches the transport only through the injected callback", () => {
    expect(code).toContain("submitPreparedVideo");
    expect(code).toContain("await submitPreparedVideo(prepared)");
  });

  it("still owns the browser preparation it was given", () => {
    for (const owned of ["extractFramesInBrowser", "extractMp4Metadata", "video-verification-acknowledged", "submittingRef"]) {
      expect(code).toContain(owned);
    }
  });

  it("handles all three transport-neutral outcomes and inspects no HTTP status", () => {
    expect(code).toContain('outcome.status === "ok"');
    expect(code).toContain('outcome.status === "rejected"');
    // Anchored on status INSPECTION, not on bare numbers: the progress interval
    // is 500ms and Tailwind emits `duration-500`, so a numeric scan would fail
    // for reasons that have nothing to do with transport.
    for (const httpish of ["res.status", "response.status", "statusCode", "res.ok", "response.ok", ".json()"]) {
      expect(code).not.toContain(httpish);
    }
  });
});

/**
 * R5-I3-A-C1 — the contract proof, made FALSIFIABLE.
 *
 * The original block here was all-negative: six `not.toContain` checks plus a
 * "types only" check. Truncating `videoUploadClientContract.ts` to zero bytes
 * left the whole 29-test suite green, because an empty file contains no
 * forbidden string either. Those assertions could not distinguish the intended
 * contract from a missing one — and R5-I3-B is going to lean on this boundary
 * while introducing provider-spending Team transport.
 *
 * The negatives are retained verbatim. What is added is a semantic proof over
 * the TypeScript AST that the intended contract is actually THERE: the required
 * exports exist, they are type declarations rather than runtime code, and they
 * carry the intended members. The AST is also what makes the forbidden-token
 * scan semantic rather than textual — identifiers and string literals are
 * examined as syntax, so a token appearing in prose cannot satisfy or break it.
 */
describe("the prepared-upload contract carries no context", () => {
  const source = read(CONTRACT);
  const code = stripComments(source);
  const sf = ts.createSourceFile(CONTRACT, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  /** Exported TYPE declarations, by name. */
  const typeExports = new Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>();
  /** Anything exported that survives to runtime — the thing this module must never gain. */
  const runtimeExports: string[] = [];
  /** Any statement that is not an import or a type declaration. */
  const runtimeStatements: string[] = [];

  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) {
      if (isExported(st)) typeExports.set(st.name.text, st);
      continue;
    }
    if (ts.isImportDeclaration(st)) {
      // A value import would pull runtime code in behind a type-only facade.
      if (!st.importClause?.isTypeOnly) runtimeStatements.push(`value import: ${st.moduleSpecifier.getText(sf)}`);
      continue;
    }
    if (ts.isExportDeclaration(st) && st.isTypeOnly) continue;
    runtimeStatements.push(ts.SyntaxKind[st.kind]);
    if (isExported(st)) runtimeExports.push(ts.SyntaxKind[st.kind]);
  }

  const memberNames = (name: string): string[] => {
    const decl = typeExports.get(name);
    if (!decl) return [];
    const node = ts.isInterfaceDeclaration(decl) ? decl : decl.type;
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isPropertySignature(n) && n.name) out.push(n.name.getText(sf));
      n.forEachChild(visit);
    };
    if (ts.isInterfaceDeclaration(node)) node.members.forEach(visit);
    else visit(node);
    return out;
  };

  // ---- POSITIVE CONTROLS: the intended contract must actually exist ----

  it("is a real, non-empty, parseable module", () => {
    expect(source.trim().length).toBeGreaterThan(0);
    expect(sf.statements.length).toBeGreaterThan(0);
    expect(typeExports.size).toBeGreaterThan(0);
  });

  it.each(["PreparedVideoUpload", "PreparedVideoMetadata", "VideoUploadSubmitOutcome", "SubmitPreparedVideo"])(
    "exports %s as a type declaration",
    (name) => {
      expect([...typeExports.keys()]).toContain(name);
      const decl = typeExports.get(name)!;
      expect(ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)).toBe(true);
    }
  );

  it("PreparedVideoUpload carries exactly the prepared-payload concepts", () => {
    const members = memberNames("PreparedVideoUpload");
    for (const required of ["fileName", "frames", "metadata", "warnings"]) {
      expect(members).toContain(required);
    }
  });

  it("PreparedVideoMetadata names the local file it describes", () => {
    const members = memberNames("PreparedVideoMetadata");
    for (const required of ["fileName", "fileType", "duration", "fileSize"]) {
      expect(members).toContain(required);
    }
  });

  it("VideoUploadSubmitOutcome declares exactly the three transport-neutral outcomes", () => {
    const decl = typeExports.get("VideoUploadSubmitOutcome");
    expect(decl && ts.isTypeAliasDeclaration(decl)).toBe(true);
    const statuses: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isPropertySignature(n) &&
        n.name.getText(sf) === "status" &&
        n.type &&
        ts.isLiteralTypeNode(n.type) &&
        ts.isStringLiteral(n.type.literal)
      ) {
        statuses.push(n.type.literal.text);
      }
      n.forEachChild(visit);
    };
    visit((decl as ts.TypeAliasDeclaration).type);
    expect(statuses.sort()).toEqual(["ok", "outcome_unknown", "rejected"]);
  });

  it("SubmitPreparedVideo is a function type from a prepared upload to an outcome", () => {
    const decl = typeExports.get("SubmitPreparedVideo") as ts.TypeAliasDeclaration;
    expect(ts.isFunctionTypeNode(decl.type)).toBe(true);
    const fn = decl.type as ts.FunctionTypeNode;
    expect(fn.parameters).toHaveLength(1);
    expect(fn.parameters[0].type!.getText(sf)).toContain("PreparedVideoUpload");
    expect(fn.type.getText(sf)).toContain("VideoUploadSubmitOutcome");
  });

  // ---- NEGATIVE BOUNDARIES, now anchored to a contract proven to exist ----

  it("stays type-only: no runtime statement, export or value import", () => {
    expect(runtimeStatements).toEqual([]);
    expect(runtimeExports).toEqual([]);
  });

  it.each(["workspaceId", "projectId", "token", "endpoint", "capabilit", "authedFetch"])("declares no %s", (forbidden) => {
    expect(code).not.toContain(forbidden);
  });

  it("names no transport or identity concept in its SYNTAX", () => {
    const seen: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPropertySignature(n)) {
        seen.push((ts.isPropertySignature(n) ? n.name : n).getText(sf));
      }
      n.forEachChild(visit);
    };
    sf.statements.forEach(visit);
    const blob = seen.join(" ").toLowerCase();
    for (const forbidden of ["workspaceid", "projectid", "token", "endpoint", "capabilit", "authedfetch", "/api/", "uid"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("is types only — no React, no network, no storage", () => {
    expect(code).not.toContain("useState");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain("localStorage");
  });
});

describe("the Personal wrapper owns exactly one endpoint", () => {
  const code = stripComments(read(PERSONAL));

  it("posts to the Personal endpoint", () => {
    expect(code).toContain('"/api/verify-video"');
    expect(code).toContain('method: "POST"');
  });

  it("never reaches a Team endpoint", () => {
    expect(code).not.toContain("/api/workspaces/");
    expect(code).not.toContain("workspaceId");
    expect(code).not.toContain("projectId");
  });

  it("owns Personal identity and the Personal success mapper", () => {
    for (const owned of ["useAuth", "getIdToken", "mergeApiSuccessToPayload"]) {
      expect(code).toContain(owned);
    }
  });

  it("renders the shared surface rather than its own uploader markup", () => {
    expect(code).toContain("VideoUploaderSurface");
    // The presentation moved out wholesale: none of it should remain here.
    for (const moved of ["extractFramesInBrowser", "video-verification-acknowledged", "dragActive", "createObjectURL"]) {
      expect(code).not.toContain(moved);
    }
  });

  it("keeps its public prop contract unchanged", () => {
    for (const prop of ["plan", "videoLimit", "videoRunsThisMonth", "onSuccess", "onUsageRefresh"]) {
      expect(code).toContain(prop);
    }
    expect(code).toContain("export default function VideoUploader");
  });
});

describe("no Team creation surface exists yet", () => {
  it.each([SURFACE, CONTRACT, PERSONAL])("%s adds no Team create affordance", (p) => {
    const code = stripComments(read(p));
    for (const forbidden of ["videos/new", "New Video", "useTeamVideoVerificationCreate", "TeamVideoComposer", "video-verifications"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
