/**
 * Order 5 Contract P — the vocabulary coverage gate (Phase 9; R1.4 M3 / M-7). Every user-facing literal with agreement
 * or disagreement vocabulary in the presentation, export and memo consumers (vocabularyScanner.ts) must be classified
 * in __fixtures__/vocabularyManifest.json with its rule, and every manifest entry must still exist — so a new literal
 * cannot reach a consumer unclassified, and a removed one cannot leave a stale rule behind. Semantics are asserted by
 * the rendering suites (markedPresentation.spec.tsx); this test enforces that nothing escapes them unlisted.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { scanVocabulary } from "./vocabularyScanner";

interface Entry {
  file: string;
  literal: string;
  count: number;
  category: string;
  rule: string;
}

const CATEGORIES = [
  "contract-p",
  "contract-p-applied",
  "historical-path",
  "historical-or-shared",
  "computed-status",
  "claim-contested-note",
  "owner-decision-D1",
  "residual-minor",
  "shared-claim-video",
  "governance-human-review",
  "other-schema",
  "prompt",
  "brand",
  "non-user",
];

const manifest: Entry[] = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "vocabularyManifest.json"), "utf8"));
const key = (file: string, literal: string) => `${file}\u0000${literal}`;

describe("vocabulary coverage gate", () => {
  const found = new Map<string, number>();
  for (const l of scanVocabulary(process.cwd())) found.set(key(l.file, l.literal), (found.get(key(l.file, l.literal)) ?? 0) + 1);
  const listed = new Map(manifest.map((e) => [key(e.file, e.literal), e]));

  it("every scanned literal is classified (no unlisted agreement / disagreement wording)", () => {
    const unlisted = [...found.keys()].filter((k) => !listed.has(k)).map((k) => k.replace("\u0000", " | "));
    expect(unlisted).toEqual([]);
  });

  it("every manifest entry still exists, with the same number of occurrences", () => {
    const stale = manifest.filter((e) => found.get(key(e.file, e.literal)) !== e.count).map((e) => `${e.file} | ${e.literal} | listed ${e.count}, found ${found.get(key(e.file, e.literal)) ?? 0}`);
    expect(stale).toEqual([]);
  });

  it("every entry has a known category and a stated rule", () => {
    for (const e of manifest) {
      expect(CATEGORIES).toContain(e.category);
      expect(e.rule.length).toBeGreaterThan(5);
    }
  });

  it("the scan is not blind: it finds the literals R1.4's reviewer cited", () => {
    const has = (file: string, literal: string) => found.has(key(file, literal));
    expect(has("components/adaptive/PrimarySynthesisStrip.tsx", '"Models agree"')).toBe(true);
    expect(has("components/adaptive/AdaptiveSynthesisReportView.tsx", '"Top consensus"')).toBe(true);
    expect(has("components/adaptive/ListView.tsx", '"Consensus claims"')).toBe(true);
    expect(has("lib/verification/generateMemo.ts", '"WHERE MODELS DISAGREE"')).toBe(true);
    expect(has("lib/adaptiveSchema/synthesisReport.ts", '"Models take different positions on this point — see each model\'s excerpt below."')).toBe(true);
  });
});
