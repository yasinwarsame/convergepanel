/**
 * Order 5 Contract P — the presentation boundary at source level. positionPresentation.ts (and its export helper)
 * import nothing that computes: no alignment, comparator, scoring, consensus-integrity mutation, gate, orchestration
 * or report builder. No computation module imports the presentation module or reads the marker, except
 * synthesisReport.ts, which writes the marker constant in its presentation() factory.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const DIR = join(process.cwd(), "lib/adaptiveSchema");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const importsOf = (src: string) => [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

const COMPUTATION = ["alignment", "fieldAlignment", "agreementComparators", "scoring", "gate", "orchestrate", "synthesisReport", "verdict", "verdictCard", "biasDetection", "coverageAudit", "diagnostics", "trustSummary", "narrativeIntegrity", "validator", "retryCorrection"];

describe("presentation / computation import boundary", () => {
  it.each(["positionPresentation.ts", "exportPositionView.ts", "comparisonNormalization.ts"])("%s imports no computation module", (file) => {
    const bad = importsOf(read(file)).filter((p) => COMPUTATION.some((c) => p === `./${c}` || p.endsWith(`/adaptiveSchema/${c}`)));
    expect(bad).toEqual([]);
    // consensusIntegrity is read through agreementNarrative / the module's own validated restatement only.
    expect(importsOf(read(file))).not.toContain("./consensusIntegrity");
  });

  it("no computation module imports the presentation module or reads the marker (synthesisReport only writes it)", () => {
    for (const f of readdirSync(DIR).filter((n) => /\.(ts|tsx)$/.test(n))) {
      const base = f.replace(/\.(ts|tsx)$/, "");
      if (!COMPUTATION.includes(base) && base !== "consensusIntegrity") continue;
      const src = read(f);
      const usesModule = importsOf(src).some((p) => /positionPresentation$/.test(p));
      if (base === "synthesisReport") {
        expect(src.match(/import \{([^}]*)\} from "\.\/positionPresentation"/)?.[1].split(",").map((s) => s.trim()).sort()).toEqual(["DISAGREEMENT_POSITION_MARKER", "DISAGREEMENT_POSITION_VERSION"]);
        expect(src).not.toMatch(/isPositionMarked|presentPositionSafeReport|positionView/);
        continue;
      }
      expect([f, usesModule]).toEqual([f, false]);
      expect([f, /disagreementPositionVersion/.test(src)]).toEqual([f, false]);
    }
  });

  it("the comparator still uses the shared normalizer (one definition)", () => {
    expect(read("fieldAlignment.ts")).toContain('import { normalizeForComparison } from "./comparisonNormalization";');
    expect(read("fieldAlignment.ts")).not.toMatch(/function normalizeForComparison/);
  });
});
