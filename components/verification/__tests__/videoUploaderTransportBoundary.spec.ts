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
    // C2. The third branch used to be named in this test and asserted nowhere —
    // and it is the one that matters, because resubmitting an unprovable
    // outcome can charge a completed run twice. The behaviour is covered by the
    // surface suite; what is pinned HERE is that the branch and its dedicated
    // state exist in the source at all.
    expect(code).toContain("setOutcomeUnknown(true)");
    expect(code).toContain('data-testid="video-upload-outcome-unknown"');
    expect(code).toContain('role="alert"');
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
 * carry the intended members.
 *
 * SCOPE, stated honestly. The forbidden-token checks are a guard against an
 * ACCIDENTAL change — a developer who writes the word `workspaceId` — and not
 * an information-flow proof. They are a blocklist of spellings: `teamId`,
 * `workspace_id` or a `\`/api/${string}\`` template-literal type would pass
 * both the textual and the syntax scan. What IS proven structurally is the
 * shape of the contract itself (direct members, the full outcome union, and
 * type-only-ness), and those are the assertions R5-I3-B should rely on.
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

  /** Every top-level type declaration in the module, exported or not — the resolution scope. */
  const localTypes = new Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>();
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) localTypes.set(st.name.text, st);
  }

  const unwrap = (t: ts.TypeNode): ts.TypeNode => (ts.isParenthesizedTypeNode(t) ? unwrap(t.type) : t);

  /**
   * C2-D1. The DIRECT members of a declaration — never a `forEachChild` sweep.
   *
   * The sweep this replaces counted members of NESTED type literals as if they
   * were top-level, so moving `fileName` into `source: { fileName: string }`
   * satisfied a test named for the public shape while `VideoUploader` still read
   * `prepared.fileName`. `null` here means "a shape this proof does not
   * understand" and every caller fails closed on it.
   */
  const directMembers = (name: string): { required: string[]; optional: string[]; all: string[] } | null => {
    const decl = localTypes.get(name);
    if (!decl) return null;
    const members = ts.isInterfaceDeclaration(decl)
      ? decl.members
      : ts.isTypeLiteralNode(unwrap(decl.type))
        ? (unwrap(decl.type) as ts.TypeLiteralNode).members
        : null;
    if (!members) return null;
    const required: string[] = [];
    const optional: string[] = [];
    for (const m of members) {
      // Anything that is not a plain property — an index or call or method
      // signature — is a shape this proof does not model. Fail closed.
      if (!ts.isPropertySignature(m) || !m.name) return null;
      (m.questionToken ? optional : required).push(m.name.getText(sf));
    }
    return { required, optional, all: [...required, ...optional] };
  };

  /** One constituent of the outcome union, reduced to what the contract promises. */
  type Variant = { status: string; required: string[]; optional: string[]; typeOf: (member: string) => string | null };

  /**
   * C2-D2. Flatten the outcome union, RESOLVING local type references.
   *
   * `| PendingOutcome` previously vanished from the status list, so a fourth
   * outcome could be added behind an alias while a test named "exactly" stayed
   * green. Resolution is deliberately limited to this module's own declarations:
   * anything else — an imported type, a mapped/conditional type, a constituent
   * with no string-literal `status` — lands in `unresolved`, which is asserted
   * empty. A shape the proof cannot read must never be silently dropped.
   */
  const resolveOutcomeUnion = (name: string): { variants: Variant[]; unresolved: string[] } => {
    const variants: Variant[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();

    const literalToVariant = (lit: ts.TypeLiteralNode): Variant | null => {
      const required: string[] = [];
      const optional: string[] = [];
      let status: string | null = null;
      for (const m of lit.members) {
        if (!ts.isPropertySignature(m) || !m.name) return null;
        const member = m.name.getText(sf);
        (m.questionToken ? optional : required).push(member);
        if (member === "status") {
          const t = m.type ? unwrap(m.type) : undefined;
          if (!t || !ts.isLiteralTypeNode(t) || !ts.isStringLiteral(t.literal)) return null;
          status = t.literal.text;
        }
      }
      if (status === null) return null;
      return {
        status,
        required,
        optional,
        typeOf: (member) => {
          const m = lit.members.find((x) => ts.isPropertySignature(x) && x.name.getText(sf) === member);
          return m && ts.isPropertySignature(m) && m.type ? m.type.getText(sf) : null;
        },
      };
    };

    const walk = (node: ts.TypeNode, path: string) => {
      const t = unwrap(node);
      if (ts.isUnionTypeNode(t)) {
        t.types.forEach((x, i) => walk(x, `${path}[${i}]`));
        return;
      }
      if (ts.isTypeLiteralNode(t)) {
        const v = literalToVariant(t);
        if (v) variants.push(v);
        else unresolved.push(`${path}: type literal without a string-literal status`);
        return;
      }
      if (ts.isTypeReferenceNode(t)) {
        const ref = t.typeName.getText(sf);
        if (seen.has(ref)) {
          unresolved.push(`${path}: cyclic reference to ${ref}`);
          return;
        }
        const target = localTypes.get(ref);
        if (!target) {
          unresolved.push(`${path}: unresolvable reference ${ref}`);
          return;
        }
        seen.add(ref);
        if (ts.isInterfaceDeclaration(target)) unresolved.push(`${path}: ${ref} is an interface, not modelled here`);
        else walk(target.type, `${path}->${ref}`);
        seen.delete(ref);
        return;
      }
      unresolved.push(`${path}: unsupported ${ts.SyntaxKind[t.kind]}`);
    };

    const decl = localTypes.get(name);
    if (!decl || !ts.isTypeAliasDeclaration(decl)) return { variants, unresolved: [`${name} is not a type alias`] };
    walk(decl.type, name);
    return { variants, unresolved };
  };

  // ---- POSITIVE CONTROLS: the intended contract must actually exist ----

  it("is a real, non-empty, parseable module", () => {
    expect(source.trim().length).toBeGreaterThan(0);
    expect(sf.statements.length).toBeGreaterThan(0);
    expect(typeExports.size).toBeGreaterThan(0);
  });

  it.each(["PreparedVideoUpload", "PreparedVideoMetadata", "VideoUploadSubmitOutcome", "SubmitPreparedVideo"])(
    "exports %s",
    (name) => {
      expect([...typeExports.keys()]).toContain(name);
    }
  );

  it("PreparedVideoUpload's DIRECT members are exactly the prepared-payload concepts", () => {
    const m = directMembers("PreparedVideoUpload");
    expect(m).not.toBeNull();
    // Exact, on purpose: the prepared payload is the thing that crosses into a
    // caller's transport, so gaining a member is as much a boundary event as
    // losing one. `fileName` must be DIRECT — `VideoUploader` reads
    // `prepared.fileName`, and a nested `source: { fileName }` is a break.
    expect(m!.required.sort()).toEqual(["fileName", "frames", "metadata", "warnings"]);
    expect(m!.optional).toEqual([]);
  });

  it("PreparedVideoMetadata names the local file among its DIRECT members", () => {
    const m = directMembers("PreparedVideoMetadata");
    expect(m).not.toBeNull();
    // Not exact: metadata legitimately grows as more container fields are
    // parsed. What is pinned is that these four describe the LOCAL file and sit
    // at the top level.
    for (const required of ["fileName", "fileType", "duration", "fileSize"]) {
      expect(m!.required).toContain(required);
    }
  });

  it("VideoUploadSubmitOutcome declares exactly three outcomes, through any local indirection", () => {
    const { variants, unresolved } = resolveOutcomeUnion("VideoUploadSubmitOutcome");
    // Fail closed: a constituent this proof cannot read must never be silently
    // dropped, or "exactly" becomes false again the moment someone adds one.
    expect(unresolved).toEqual([]);
    expect(variants.map((v) => v.status).sort()).toEqual(["ok", "outcome_unknown", "rejected"]);
  });

  it("each outcome branch carries the payload the contract promises", () => {
    const { variants } = resolveOutcomeUnion("VideoUploadSubmitOutcome");
    const byStatus = (s: string) => variants.find((v) => v.status === s);

    // ok: the success value is the entire point of the branch. Deleting it left
    // the previous proof green.
    const ok = byStatus("ok")!;
    expect(ok.required.sort()).toEqual(["status", "value"]);
    expect(ok.optional).toEqual([]);
    expect(ok.typeOf("value")).toBe("TSuccess");

    // rejected: a PROVEN refusal always carries presentation copy; the upgrade
    // hint is the one optional part.
    const rejected = byStatus("rejected")!;
    expect(rejected.required.sort()).toEqual(["message", "status"]);
    expect(rejected.optional).toEqual(["showUpgrade"]);
    expect(rejected.typeOf("message")).toBe("string");

    // outcome_unknown: carries nothing. Any payload here would imply the
    // transport knew something it has just said it could not prove.
    const unknown = byStatus("outcome_unknown")!;
    expect(unknown.required).toEqual(["status"]);
    expect(unknown.optional).toEqual([]);
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
      // Property names are reached as their own Identifier/StringLiteral child,
      // so there is no separate PropertySignature case to add.
      if (ts.isIdentifier(n) || ts.isStringLiteral(n)) seen.push(n.getText(sf));
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
