/**
 * #290 Increment 1 — the readable layout is UI-only.
 *
 *  1. Nothing that computes, persists or exports imports it: no file under lib/adaptiveSchema, lib/pdf, lib/docx,
 *     lib/firestore, lib/runs, lib/verification, lib/governance, lib/stripe, app/api or lib/research's own persisted
 *     run interpretation imports lib/research/readableReport or components/research/readable.
 *  2. The readable modules import only presentation: types, the frozen gate wording, the copy module, and (for the
 *     components) React and existing client components. No server-only, Firestore, fetch, env, or computation module.
 *  3. Only the files this increment threads the layout through name it.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
// Static, side-effect (`import "x"`), dynamic and require forms.
const importsOf = (src: string) => [...src.matchAll(/(?:from\s+|\bimport\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);

function walk(rel: string): string[] {
  const p = join(ROOT, rel);
  if (statSync(p).isFile()) return [rel];
  return readdirSync(p).flatMap((name) => {
    if (name === "__tests__" || name === "__fixtures__" || name === "node_modules") return [];
    const child = join(rel, name);
    return statSync(join(ROOT, child)).isDirectory() ? walk(child) : /\.(ts|tsx)$/.test(name) ? [child] : [];
  });
}

const READABLE = /readableReport|components\/research\/readable|\/readable\//;

describe("readable layout import boundary", () => {
  it.each(["lib/adaptiveSchema", "lib/pdf", "lib/docx", "lib/firestore", "lib/runs", "lib/verification", "lib/governance", "lib/stripe", "lib/synthesis", "app/api", "lib/research/persistedRunPresentation.ts"])(
    "no %s file imports lib/research/readableReport or components/research/readable",
    (root) => {
      const bad = walk(root).filter((f) => importsOf(readFileSync(join(ROOT, f), "utf8")).some((p) => READABLE.test(p)));
      expect(bad).toEqual([]);
    }
  );

  it("the only production files that name the readable layout are the new modules and the four threaded files plus the two shells", () => {
    const named = ["app", "components", "lib", "hooks"]
      .flatMap((r) => walk(r))
      .filter((f) => importsOf(readFileSync(join(ROOT, f), "utf8")).some((p) => READABLE.test(p)))
      .filter((f) => !f.startsWith("lib/research/readableReport/") && !f.startsWith("components/research/readable/"))
      .map((f) => relative(ROOT, join(ROOT, f)))
      .sort();
    expect(named).toEqual([
      "components/ResultsDisplay.tsx",
      "components/adaptive/AdaptivePanelResponse.tsx",
      "components/research/PersistedResearchResultView.tsx",
      "components/workspace/PersonalResearchDetailShell.tsx",
      "components/workspace/projects/TeamResearchDetailShell.tsx",
    ]);
  });

  const LIB_ALLOWED: Record<string, string[]> = {
    "lib/research/readableReport/layoutMode.ts": ["./layoutRollout"],
    "lib/research/readableReport/layoutRollout.ts": [],
    "lib/research/readableReport/copy.ts": [],
    "lib/research/readableReport/answerStatus.ts": ["@/lib/adaptiveSchema/types", "./copy"],
    "lib/research/readableReport/trustSignals.ts": ["@/lib/adaptiveSchema/types", "@/lib/adaptiveSchema/gatePresentation", "./copy"],
  };

  it("every readableReport module is listed, and imports exactly its allow-list (pure presentation)", () => {
    expect(walk("lib/research/readableReport").sort()).toEqual(Object.keys(LIB_ALLOWED).sort());
    for (const [f, allowed] of Object.entries(LIB_ALLOWED)) expect([f, importsOf(readFileSync(join(ROOT, f), "utf8")).sort()]).toEqual([f, [...allowed].sort()]);
  });

  it("the readable components import no server, data-access, network, env or computation module", () => {
    const FORBIDDEN = /server-only|firebase|firestore|authedFetch|\/api\/|lib\/env|lib\/logger|adaptiveSchema\/(gate|trustSummary|scoring|alignment|orchestrate|synthesisReport|verdict|verdictCard|consensusIntegrity|exportSnapshot|shareBuilders|jsonExport)$/;
    for (const f of walk("components/research/readable")) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect([f, importsOf(src).filter((p) => FORBIDDEN.test(p))]).toEqual([f, []]);
      expect([f, /\bfetch\(|process\.env|dangerouslySetInnerHTML/.test(src)]).toEqual([f, false]);
    }
  });
});
