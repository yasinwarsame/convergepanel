/**
 * Order 5 Contract P — source-level vocabulary scanner (the R1.4 reviewer's widened scan, tools/inventory_wide.py,
 * ported): every user-facing string literal or JSX text in the presentation, export and memo consumers that carries
 * agreement or disagreement vocabulary. vocabularyInventory.spec.ts requires each one to be classified in the checked-in
 * manifest, and every manifest entry to still exist — coverage is enforced, not listed. The scanner proves no
 * semantics on its own; the marked-rendering assertions (markedPresentation.spec.tsx) do.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

export const SCANNED_ROOTS = ["components/adaptive", "lib/adaptiveSchema", "lib/pdf", "lib/docx", "lib/verification/generateMemo.ts", "lib/panel/runModelIdentity.ts"];

export const VOCAB =
  /\b(agree\w*|consensus|majority|diverg\w*|contested|camps?|split|disagree\w*|disput\w*|different positions|converg\w*|oppos\w*|supported by|disputed by|supporters?|disputers?|unresolved|vote\w*|align\w*)\b/i;
const LITERAL = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|>[^<>{}]+<)/g;
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

/** Literals with vocabulary, whitespace-normalized; one entry per occurrence. */
export function scanVocabulary(repoRoot: string): Literal[] {
  const out: Literal[] = [];
  for (const rel of SCANNED_ROOTS.flatMap((r) => files(repoRoot, r)).sort()) {
    const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
    for (const line of lines) {
      const s = line.trim();
      if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("import ")) continue;
      for (const m of line.matchAll(LITERAL)) {
        const lit = m[0];
        if (!VOCAB.test(lit) || BARE_ENUM.test(lit)) continue;
        out.push({ file: relative(repoRoot, join(repoRoot, rel)), literal: lit.replace(/\s+/g, " ") });
      }
    }
  }
  return out;
}
