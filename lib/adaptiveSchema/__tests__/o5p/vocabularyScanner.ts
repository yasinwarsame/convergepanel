/**
 * Order 5 Contract P — source-level vocabulary scanner (the R1.4 reviewer's widened scan, tools/inventory_wide.py,
 * ported): every user-facing string literal or JSX text in the presentation, export and memo consumers that carries
 * agreement or disagreement vocabulary. vocabularyInventory.spec.ts requires each one to be classified in the checked-in
 * manifest, and every manifest entry to still exist — coverage is enforced, not listed. The scanner proves no
 * semantics on its own; the marked-rendering assertions (markedPresentation.spec.tsx) do.
 *
 * m-7: literals are read from the parsed source (the TypeScript compiler's own AST), not line by line — so JSX text
 * that spans lines, or that sits beside a `{…}` expression ("aligns {n}/{m}"), and string or template literals that
 * span lines are all seen; comments and import specifiers are not literals. A coverage aid only: it does not replace
 * the rendering tests.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

export const SCANNED_ROOTS = ["components/adaptive", "lib/adaptiveSchema", "lib/pdf", "lib/docx", "lib/verification/generateMemo.ts", "lib/panel/runModelIdentity.ts"];

export const VOCAB =
  /\b(agree\w*|consensus|majority|diverg\w*|contested|camps?|split|disagree\w*|disput\w*|different positions|converg\w*|oppos\w*|supported by|disputed by|supporters?|disputers?|unresolved|vote\w*|align\w*|contradict\w*|unanim\w*|concur\w*|dissent\w*|corroborat\w*|endorse\w*|unique claims?|same answers?)\b/i;
const BARE_ENUM = /^["'`][a-z_]+["'`]$/;

export interface Literal {
  file: string;
  literal: string;
}

function files(root: string, rel: string): string[] {
  const p = join(root, rel);
  if (statSync(p).isFile()) return [rel];
  return readdirSync(p).flatMap((name) => {
    if (name === "__tests__" || name === "__fixtures__" || name === "node_modules") return [];
    const child = join(rel, name);
    if (statSync(join(root, child)).isDirectory()) return files(root, child);
    return /\.(ts|tsx)$/.test(name) ? [child] : [];
  });
}

/**
 * Every literal of one source text, whitespace-normalized, in source order: string and template literals as written
 * (quotes included; a template with its `${…}` parts as written), JSX text as `>text<`. Import / export specifiers are
 * skipped; comments are never literals.
 */
export function sourceLiterals(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExternalModuleReference(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.getText(sf).replace(/\s+/g, " "));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      out.push(node.getText(sf).replace(/\s+/g, " "));
      // Literals nested inside the template's `${…}` expressions are literals of their own.
      node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    if (ts.isJsxText(node)) {
      const text = node.getText(sf).replace(/\s+/g, " ").trim();
      if (text) out.push(`>${text}<`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Literals with vocabulary, whitespace-normalized; one entry per occurrence. */
export function scanVocabulary(repoRoot: string, roots: readonly string[] = SCANNED_ROOTS): Literal[] {
  const out: Literal[] = [];
  for (const rel of roots.flatMap((r) => files(repoRoot, r)).sort()) {
    for (const lit of sourceLiterals(readFileSync(join(repoRoot, rel), "utf8"), rel)) {
      if (!VOCAB.test(lit) || BARE_ENUM.test(lit)) continue;
      out.push({ file: relative(repoRoot, join(repoRoot, rel)), literal: lit });
    }
  }
  return out;
}
