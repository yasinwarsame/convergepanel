/**
 * Model-identity PR A — call-site classification, pinned.
 *
 * Product-selection labels ("GPT 5.2", …) may be read ONLY by the generic /
 * product surfaces listed below. Every completed-run, export, share,
 * synthesis and governance surface names models through
 * `lib/panel/runModelIdentity.ts`. A new reader of the product labels must be
 * classified here deliberately; it cannot slip onto a run surface unnoticed.
 */
import fs from "fs";
import path from "path";

const ROOTS = ["app", "components", "lib", "hooks"];
const PRODUCT_LABEL_READERS = /getModelDisplayNameSafe|getModelDisplayName\b|MODEL_INFO|PANEL_MODELS|getPanelModelConfig\([^)]*\)\.label/;

/** Generic / product surfaces — allowed to show the product-selection label. */
const ALLOWED: Record<string, string> = {
  "app/about/page.tsx": "product description page (ModelChip labelKind=\"product\")",
  "app/page.tsx": "in-flight 'Querying models' status chips before a run completes (pre-run UI)",
  "components/ModelChip.tsx": "product label only behind the explicit labelKind=\"product\" opt-in",
  "components/ModelPicker.tsx": "model selection buttons",
  "lib/adaptiveSchema/modelNameValidator.ts": "LLM-prose hallucination filter in the synthesis pipeline (no presentation; out of PR A scope)",
  "lib/modelInfo.ts": "deprecated label registry (definition)",
  "lib/panelModels.ts": "product label registry (definition)",
  "lib/utils/normalizeSelectedModels.ts": "slot-id validation only",
};

/** Completed-run / export / share / governance surfaces this PR moved onto runModelIdentity. */
const RUN_SURFACES = [
  "lib/pdf/AdaptiveResearchDocument.tsx",
  "lib/docx/AdaptiveResearchDocxDocument.ts",
  "lib/adaptiveSchema/exportRunProvenance.ts",
  "lib/adaptiveSchema/shareBuilders.ts",
  "lib/adaptiveSchema/verdict.ts",
  "lib/consensus.ts",
  "lib/panel/substitutionDisplay.ts",
  "lib/verification/generateMemo.ts",
  "components/ResultsDisplay.tsx",
  "components/PanelSynthesisView.tsx",
  "components/adaptive/shared.tsx",
  "components/adaptive/ModelResponsesSection.tsx",
  "components/adaptive/AdaptiveSynthesisReportView.tsx",
  "components/verification/ClaimVerificationResultView.tsx",
  "components/governance/GovernanceDashboard.tsx",
  "components/workspace/projects/TeamResearchResultView.tsx",
  "app/api/governance/queue/route.ts",
];

function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
}

describe("product-label readers are exactly the classified generic surfaces", () => {
  it("no unclassified file reads a product-selection label", () => {
    const files: string[] = [];
    for (const root of ROOTS) walk(root, files);
    const readers = files.filter((f) => PRODUCT_LABEL_READERS.test(codeOf(f))).sort();
    expect(readers).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(RUN_SURFACES)("%s names models only through runModelIdentity", (rel) => {
    const code = codeOf(rel);
    expect(code).not.toMatch(PRODUCT_LABEL_READERS);
    expect(code).toMatch(/runModelIdentity|exportModelIdentityLabel|getModelLabel/);
  });
});
