/**
 * Order 6 / S-E.2 boundaries (X-10, X-12): files the change must not touch are byte-identical to main 0249a4e5 (content
 * sha256, captured from the unchanged base worktree), and the files it does touch add no data read, network call,
 * authorization or flag dependency. Also pins an inherited defect the fixtures exposed, unchanged by S-E.2.
 */
jest.mock("firebase-admin/firestore", () => ({ FieldValue: class FieldValue {}, Timestamp: class Timestamp {} }));

import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { dsOutput, dsStates, GOVERNANCE_VARIANTS } from "./dsExportFixtures";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";

const ROOT = path.resolve(__dirname, "../../../..");
const sha = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");

/** Content sha256 at 0249a4e5: export routes, JSON export, render dispatchers, persistence, audit, receipt builder,
 * matcher, consensus/grounding calculations, status labels, Firestore rules, env/flags, provenance adapters. */
const UNCHANGED: [string, string][] = [
  ["app/api/user/runs/[runId]/export/route.ts", "898a5a9124fb15da1b1bc56c7f2fb6d6230a09dfe30b404f9fb028c5a782e0b9"],
  ["app/api/user/runs/[runId]/exports/[exportId]/route.ts", "f7d50b1b92537eac2268a395074ab2b4d2ebc6143d252147c7ec75283161a5e8"],
  ["app/api/user/runs/[runId]/exports/route.ts", "0e7fae26a0f1350036ee7a65e82fb4c536f77d773f5d14bc90e505fdf1436949"],
  ["app/api/workspaces/[workspaceId]/runs/[runId]/export/route.ts", "47126e77a577c2c0a6cc7d367c9ced0c941e6bd79964726f084ab59eb4f81aef"],
  ["app/api/workspaces/[workspaceId]/runs/[runId]/exports/[exportId]/route.ts", "ad9bee82d655d17d13cc3032242f06eff81d944d2881ee87da17760bc54799a5"],
  ["app/api/workspaces/[workspaceId]/runs/[runId]/exports/route.ts", "b154a3baba388617a01d91e882458ae9a50afab19874cc0df05306fac94f8edf"],
  ["lib/adaptiveSchema/jsonExport.ts", "5619af6ce06c319a6e91821d3b92108d81c78fce74fad384b01f21ee4dad827c"],
  ["lib/adaptiveSchema/jsonExportSchema.ts", "e50f144b619e0c81faf78bbc61adc71ac27ab944795649cb9fdbc864bb6aeacb"],
  ["lib/pdf/renderAdaptiveResearchPdf.ts", "efc6da0857c4a3734cf0eb97f5387d1eadd6319330e4b61202d5c3ca46f266fd"],
  ["lib/docx/renderAdaptiveResearchDocx.ts", "80fb811d7df16b2c303f1583b748f68d98e0b283c300d128a9ffd87ce575fec1"],
  ["lib/firestore/adaptiveExports.ts", "4385a42a3d447ccd846fa1b2e08a5816c8120e3be66e99e9191ab8a0d661bf1f"],
  ["lib/firestore/sanitizeForFirestore.ts", "323a430eab2314603ca4c878df5b29f1bc310f9f86c92dee96cb847bb17ba28a"],
  ["lib/adaptiveSchema/decisionReceiptBuilder.ts", "6a5f8c1e2830611dfa59b24152a3ddbf2da1b915a2c14c199c01753f0a3402d7"],
  ["lib/adaptiveSchema/decisionSupportAlignment.ts", "792f32ebd5fbe43881a34466e8dc8cae1c083caee6af19f712c70bbe43bd9462"],
  ["lib/adaptiveSchema/reportSummary.ts", "3acc265a3cc1ddf994d94bc09a48666b5a366980d7fe6e1f399778bbc12e948d"],
  ["lib/adaptiveSchema/exportContentDerivation.ts", "4f520bf8c61cba47e8508da6211f155dd281886d624037239f746bd215e4d298"],
  ["lib/adaptiveSchema/reportStatus.ts", "88dc403ded11dc7a52811d9a7102aa7f697abb69ccc5a19d52e639369ca5d957"],
  ["firestore.rules", "7edff7ebf3a32fb3d646c53c5e9898718bc559aa94a969880af40e0bf2a594ed"],
  ["lib/governance/auditLog.ts", "dc235b536961127e58af1c95c22e6ffd78b301a694b11f4668ec2973588d68db"],
  ["lib/env.ts", "8c824e1ef193bb13a128edecddfef1665564bb76a97a734d4bd913711386688a"],
  ["lib/adaptiveSchema/dsProvenanceRouteAdapter.ts", "0c8c4050a8ec1011471053d09a616326955e8ff4b6084474e32063091562f2c5"],
  ["lib/adaptiveSchema/dsProvenanceViewMin.ts", "c069937e471802bba242da41b17857c30fc1058784cb14379738e28eca5b03df"],
  ["lib/adaptiveSchema/exportGeneratedBy.ts", "dfd7e1dfe4d7f635962d8bdacbbc013394ca0c61770b055638397964f19fbc6c"],
  ["lib/adaptiveSchema/exportRunProvenance.ts", "eed9dd40aab626daa2aa88aaef16f707a05643d432505bb6b2adb8cbd34a5028"],
];

/**
 * The production files S-E.2 changes (owner §9 scope), with their complete import lists. The lists are the 0249a4e5
 * lists plus only the wording module, which itself imports nothing but types: no data access, network, authorization,
 * environment or flag module can enter through these files.
 */
const CHANGED_IMPORTS: Record<string, string[]> = {
  "lib/adaptiveSchema/researchExport.ts": ["../types", "./exportGeneratedBy", "./governanceRecord", "./persistedOutput", "./reportStatus", "./reportSummary", "./types"],
  "lib/adaptiveSchema/exportSnapshot.ts": ["../types", "./decisionReceiptBuilder", "./dsLabelWording", "./exportRunProvenance", "./gatePresentation", "./governanceRecord", "./persistedOutput", "./reportStatus", "./reportSummary", "./researchExport", "server-only"],
  "lib/adaptiveSchema/dsLabelWording.ts": ["./types"],
  "lib/pdf/AdaptiveResearchDocument.tsx": ["./theme", "@/lib/adaptiveSchema/agreementNarrative", "@/lib/adaptiveSchema/dsLabelWording", "@/lib/adaptiveSchema/exportContentDerivation", "@/lib/adaptiveSchema/exportPositionView", "@/lib/adaptiveSchema/exportRunProvenance", "@/lib/adaptiveSchema/positionPresentation", "@/lib/adaptiveSchema/reportPresentation", "@/lib/adaptiveSchema/reportSummary", "@/lib/adaptiveSchema/researchExport", "@/lib/adaptiveSchema/schemaRegistry", "@/lib/adaptiveSchema/types", "@react-pdf/renderer", "react"],
  "lib/docx/AdaptiveResearchDocxDocument.ts": ["@/lib/adaptiveSchema/agreementNarrative", "@/lib/adaptiveSchema/dsLabelWording", "@/lib/adaptiveSchema/exportContentDerivation", "@/lib/adaptiveSchema/exportPositionView", "@/lib/adaptiveSchema/exportRunProvenance", "@/lib/adaptiveSchema/positionPresentation", "@/lib/adaptiveSchema/reportPresentation", "@/lib/adaptiveSchema/reportSummary", "@/lib/adaptiveSchema/researchExport", "@/lib/adaptiveSchema/schemaRegistry", "@/lib/adaptiveSchema/types", "docx"],
};
const importsOf = (file: string) => Array.from(new Set(Array.from(readFileSync(path.join(ROOT, file), "utf8").matchAll(/(?:from|import)\s+"([^"]+)"/g), (m) => m[1]))).sort();

describe("S-E.2 boundaries", () => {
  it.each(UNCHANGED)("%s is byte-identical to main 0249a4e5", (file, expected) => {
    expect(sha(file)).toBe(expected);
  });

  it.each(Object.keys(CHANGED_IMPORTS))("%s imports exactly its 0249a4e5 modules plus the wording module", (file) => {
    expect(importsOf(file)).toEqual([...CHANGED_IMPORTS[file]].sort());
  });

  it("the wording module stays free of side effects: no process.env, fetch, storage or flag access", () => {
    const src = readFileSync(path.join(ROOT, "lib/adaptiveSchema/dsLabelWording.ts"), "utf8");
    for (const forbidden of [/process\.env/, /\bfetch\(/, /adminDb/, /firebase/i, /DS_PROVENANCE/]) expect(forbidden.test(src)).toBe(false);
  });

  it("the marker is written in exactly one place: the snapshot builder's Decision Support branch", () => {
    const writers = Object.keys(CHANGED_IMPORTS).filter((f) => /dsLabelWordingVersion\s*:/.test(readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(writers).toEqual(["lib/adaptiveSchema/exportSnapshot.ts"]);
    const builder = readFileSync(path.join(ROOT, "lib/adaptiveSchema/exportSnapshot.ts"), "utf8");
    expect(builder).toContain('...(output.schemaId === "decision_support" ? { presentation: { dsLabelWordingVersion: DS_LABEL_WORDING_VERSION } } : {})');
  });
});

describe("inherited defect, unchanged by S-E.2 (reported, not fixed: the receipt builder is out of scope)", () => {
  it("a Decision Support result without a `sources` field cannot get a receipt: buildExportSnapshot throws with a governance record", () => {
    const legacy = dsStates().find((s) => s.name === "legacy_no_sources_field")!;
    const input = { question: "q", selectedModels: [], runDocument: undefined, milestone2: { output: dsOutput(legacy), governanceRecord: GOVERNANCE_VARIANTS[0].record } };
    expect(() => buildExportSnapshot(input as never)).toThrow(TypeError);
    // Without a governance record (no receipt) it builds.
    expect(() => buildExportSnapshot({ ...input, milestone2: { output: dsOutput(legacy) } } as never)).not.toThrow();
  });
});
