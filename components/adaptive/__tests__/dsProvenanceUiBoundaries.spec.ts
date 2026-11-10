/**
 * Order 6 / S-2a — boundaries of the dark provenance UI.
 *
 *  1. Every forbidden layer is byte-identical to main 9eca1e3 (git blob ids): the routes, the adapters and the
 *     S-1a-min builder, the flag (lib/env.ts), export and snapshot code, matching / consensus / receipt code, the
 *     S-E.1 surfaces (both Team-page D-9 copies stay where they are: Q1), Firestore rules and the legacy dashboard.
 *  2. The new modules read nothing but what they are handed: no request, no environment, no HTML injection, no link.
 *  3. The S-2a display vocabulary, classified by origin (owner §8): fixed system-authored labels, model-authored source
 *     material, reviewer-authored conditions and system-recorded states. Visible only when the server flag is on;
 *     the flag is absent in Production.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import * as DisplayText from "@/lib/adaptiveSchema/dsProvenanceDisplayText";

const ROOT = process.cwd();
const gitBlob = (data: Buffer) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** `git rev-parse 9eca1e3:<path>` for every file S-2a must not change. */
const UNCHANGED_AT_9ECA1E3: Record<string, string> = {
  "app/api/user/runs/[runId]/route.ts": "091f4ea06144891ee1a98779cec9fc4948d9e785",
  "app/api/user/runs/[runId]/governance/route.ts": "91647ab52a8e933d63565cf8a47d49f246626814",
  "app/api/workspaces/[workspaceId]/runs/[runId]/route.ts": "e3f4170cc226e463d1f35b385cce79f19bb2ab2f",
  "app/api/user/runs/[runId]/export/route.ts": "3b74c7472310a69bac896f5c87f17b3edf32890d",
  "app/api/user/runs/[runId]/exports/route.ts": "8968d1e5dc7f84954417311c6189dd80d2839084",
  "app/api/user/runs/[runId]/exports/[exportId]/route.ts": "b172893d368271c2b625133553ecb77e06c556cb",
  "app/api/workspaces/[workspaceId]/runs/[runId]/exports/route.ts": "3308ae1ae7585abd83e13004392d70964b1fd699",
  "lib/adaptiveSchema/dsProvenanceViewMin.ts": "fb2f0f5ec09593b8fea01d173aeaba6e1f2b59af",
  "lib/adaptiveSchema/dsProvenanceRouteAdapter.ts": "ac1f027bb128534c75c1270351e03e294b83240f",
  "lib/env.ts": "2b81ae7239ea4fd655b8320d5bf726c778149a20",
  "lib/adaptiveSchema/exportSnapshot.ts": "5af930878120bbda7ba49ec40045502416859d19",
  // Owner order C3 (review of cf74a52, controlled exception): ONLY the unmarked verdict section's headings — when
  // exportPositionSafeReport reports the top claim's supporting slots as not independent executing models
  // (`independence`), the section label is "Where models agree / disagree (counted by executing model)" / "(model
  // independence unverified)" and the top sub-label is the qualified top heading; otherwise the same literals and the
  // same element tree / paragraphs as before. No provenance code, no import change; the qualified answer / card text
  // comes from exportPositionView.ts. Pinned by DS_FROZEN_EXPORT_DIFF below and by historicalAgreementIndependence.spec.tsx.
  // Was 10ba10b9d413214b7e4e00c422f9b15ab640d26a (PDF) and 4e8ba97ea8d0ad4bc9e13d2a598121da2ff657b0 (DOCX) at 9eca1e3.
  // c16 (review of 48f3739, MAJOR-2, same controlled exception): ONLY the report status summary's level, labelled as the
  // verification gate when the exported run's slots are not independent executing models or its execution is not
  // recorded (pre-6.2b). Was 6bd87796ec04f361792a5afe6ccbf8cc21155591 (PDF) and c7c4d4ab97121e5a335ad5b7acd7aa934b138dca
  // (DOCX) at 48f3739. Pinned edit-by-edit by DS_FROZEN_EXPORT_DIFF below.
  // Order 31 PROPOSAL (R-2 / R-3, needs owner authorization): ONLY the Milestone-2 summary level, labelled by panel slot
  // (exportMilestone2SummaryLevel / slotAgreementWord). Was cdf8bba191f6f24770273c7420d7643db2fd0604.
  "lib/pdf/AdaptiveResearchDocument.tsx": "80e8678d497d7f41a3d7bee48026832f0ec14736",
  // Order 31 PROPOSAL (R-2 / R-3, needs owner authorization): ONLY the Milestone-2 summary level, labelled by panel slot
  // (exportMilestone2SummaryLevel / slotAgreementWord). Was 5c2e1b25ce67efc4661db0ab9004c18d1de6298e.
  "lib/docx/AdaptiveResearchDocxDocument.ts": "d62e84cffefc0a1c7abfb0e42df75ab0f35cf208",
  "lib/adaptiveSchema/dsLabelWording.ts": "db50c0e7b9cec1ad8416a566b2d08c4ed16fefa1",
  "lib/adaptiveSchema/decisionSupportAlignment.ts": "b19e49caacc05c52c17a4676a7321dca654d132c",
  "lib/adaptiveSchema/decisionReceiptBuilder.ts": "e32c42b64d7d1d05f41dee95c548dacc76668640",
  "lib/adaptiveSchema/governanceRecordParser.ts": "2a195deca74df74c0f4701743bf1f78033ffc5e2",
  // P0 research-results restoration (owner-approved 2026-11-01): `generic` added to the legacy persisted allowlist
  // and its comment only; no provenance code. Was 9f9ca552d033bcdabe5fcb52862356e5f638e8b5 at 9eca1e3.
  "lib/adaptiveSchema/persistedOutput.ts": "f570388ba819d8fa49096b1bf2405a2525ad6494",
  // Shared Adaptive Schema Ruling B (owner-approved 2026-11-02): additive response-time `adaptive.modelResults` (per-model
  // results rebuilt from the saved responses); no provenance code. Was 3b4868c206dfb252f9931c075953b3c0e139b371 at 9eca1e3.
  // Re-pinned (owner-authorized saved-copy retry notice, 2026-11-07): passes the slots the persisted retry record
  // establishes as retried+included to reconstructModelResults (notice wording only); no provenance code.
  // 2d897bfb98ee985786a7fee696d2be7bb7534933 → ca6e3327bd8e3f2a651194aee1c2b459523b12bb.
  "lib/runs/runReadPayload.ts": "ca6e3327bd8e3f2a651194aee1c2b459523b12bb",
  // Re-pinned (owner-authorized F-2, Order 34 — "mock response" text is not an authority signal): ONLY copies the
  // persisted structured execution fact `outputClass` ("model_response", written on NEW rows at completion) onto the
  // saved result row when the row carries it; no provenance code. d1ed5a2d6d9caafa3d7e63d18307919ca7cb4cf1 →
  // 09f84f9f7256d2f5fc77b1bee2b7441f5e1b9367.
  "lib/user/runDocumentToPublicResults.ts": "09f84f9f7256d2f5fc77b1bee2b7441f5e1b9367",
  // Order 6 critical-contrast slice (class-only; see criticalContrastSlice.ts): was 49c7924bbb7bf9466ab7cc8b7cd23a0f2294db85 at 9eca1e3.
  "components/adaptive/DecisionSupportView.tsx": "e3beb32c1161f42d84222b1633a6bd8b1bb98939",
  "components/adaptive/DsReceiptWording.tsx": "71b1542ecc11532f26f0bf8a758fffe311775ac6",
  "components/adaptive/PanelEvidenceSection.tsx": "01fa50175cc4a014ad17d2abad806b8eec999170",
  // c16 (review of 48f3739, MAJOR-2): ONLY the consensus field of a run whose slots are not independent executing models
  // (never Decision Support). Was ea8b059bbafe1589fe79f1a3824c298d5a68926b at 9eca1e3 and 48f3739; pinned edit-by-edit by
  // DS_FROZEN_EXPORT_DIFF below.
  // Order 31 PROPOSAL (R-2 / R-3, needs owner authorization): ONLY the Milestone-2 summary level, labelled by panel slot
  // (exportMilestone2SummaryLevel / slotAgreementWord). Was 258f2cd0611c0abecd16cb5e9f226c901b69722b.
  "components/adaptive/TopSummaryBar.tsx": "0617d5ca9a3be1e6768655107de2b38a512f72eb",
  // Order 6 critical-contrast slice (class-only; see criticalContrastSlice.ts): was 52464f6b4c8d3d330ac1764ff711297e2c31ecbe at 9eca1e3.
  "components/workspace/projects/TeamResearchReviewSummary.tsx": "16a12b9d0f15c5297a8745958126cdd6ea50d263",
  // Connector fail-closed correction pass (owner-authorized 2026-11-05, finding C): ONLY the legacy-panel synthesis
  // eligibility — the generateSynthesisAutomatically pre-flight and the history auto-synthesis condition now require
  // two INDEPENDENT executing models (meetsIndependentSynthesisMinimum, the server gate's rule); no provenance code.
  // Was 6dbe9b1f924731e1417655a68f41cd232f7cd16a at 9eca1e3.
  // Review of 262ef64, B1 (claim surfaces): ONLY the claim history line (claimHistoryConsensusSuffix) and the live claim
  // payload / history item carrying modelIndependence; no provenance code. Was 3826603986f4b86b7425a8055aecc3354ab2bc24.
  // Review of 0ca72b0, owner order B1 (cached claim payloads): ONLY mergeHistoryById reconciling a cached claim payload
  // with the server row's independence and openHistoryItem reading the user's own record when a cached payload records
  // none (lib/verification/cachedClaimProvenance.ts); no provenance code. Was 5bca766b6b3e3d04c9bba07aa2881e4005a14a70.
  // Review of 71b03e3, NIT-2: ONLY a sequence guard in openHistoryItem (historyOpenSeq) so a slow read for an earlier
  // history selection never commits over a later one; no provenance code. Was 736663e85981f6da7e6a46a55554ea9ad0cc1a20.
  // Review of 1ee4982, MINOR-A: ONLY the History open loading indicator — openHistoryItem's claim/video reads moved
  // into lib/client/historyDetailOpen.ts (each open replaces the indicator; cached/navigating opens clear it; tab
  // changes and supersedeRunningResearch end pending opens); no provenance code. Was 8e20322c531f0d4e9df9e954d38c4a029af03460.
  // Phase 0 compatibility restoration (owner Option C, 2026-11-08; inventory v3.4 A.7.1 row 6 / H-8 (1)): ONLY the two
  // legacy-panel synthesis-eligibility sites (L03 sites 3–4) are restored to the 35933c8 slot rule
  // (`okResults.length < 2` pre-flight; `filter(isUsableResult).length >= 2` history auto-synthesis) and the now-unused
  // meetsIndependentSynthesisMinimum import is removed; no provenance code. Was 70023e0b7a51822698b062dc8c0120bf8bf9aa81.
  "app/page.tsx": "8d97e6296c16b9b0a41c30a8311a88e61de9c9a5",
  // Re-pinned (owner-authorized SEC-2 / S4 provider-key boundary, 2026-11-09): `isAdminClaim()` and the
  // `appConfig/modelKeys` admin-claim grant removed, replaced by a deny-only `match /appConfig/{doc=**}`; no other
  // rule and no provenance code. 2fb80a11bfa6c55fe94e0438a980a3b0794aeafd → 747ccef5fc43f83bb08a986fadb49d5ca5d68e06.
  "firestore.rules": "747ccef5fc43f83bb08a986fadb49d5ca5d68e06",
};

/**
 * Changed since 9eca1e3 by #290 Inc 1 and re-pinned to the exact new content (owner-authorized Option A, 2026-11-05) —
 * kept apart from UNCHANGED_AT_9ECA1E3 so that map's name stays true for this file:
 *   - ReviewGovernanceSection.tsx: an optional, readable-only `legacyGateBannerLabels` prop threaded to the gate banner
 *     and the full synthesis report; classic callers never pass it and render byte-identically; no provenance code.
 *     Was c5298d27bb4e52562fc9865b17875ee87fc04d5c (unchanged since 9eca1e3).
 *     Re-pinned again (owner ruling on review of 082a2a7, MINOR-1/MINOR-2 — one readable gate presentation): the
 *     readable-only prop is now `readableGate` (the page's one gate presentation), handed to the gate banner, the Panel
 *     Verdict card and the full synthesis report; classic callers still pass nothing and render byte-identically; no
 *     provenance code. 5cc7f903a5a66f0ab7101d2a58b2616d569191e0 → 7eaba3c9d076525f9182610a590bfcb9466a1157.
 */
const CHANGED_BY_290_INC1_READABLE_GATE_OPTION: Record<string, string> = {
  "components/adaptive/ReviewGovernanceSection.tsx": "7eaba3c9d076525f9182610a590bfcb9466a1157",
};

describe("forbidden layers are unchanged from main 9eca1e3", () => {
  it.each(Object.entries(UNCHANGED_AT_9ECA1E3))("%s", (path, blob) => {
    expect(gitBlob(readFileSync(join(ROOT, path)))).toBe(blob);
  });

  it.each(Object.entries(CHANGED_BY_290_INC1_READABLE_GATE_OPTION))("%s (changed by #290 Inc 1, pinned to its new content)", (path, blob) => {
    expect(gitBlob(readFileSync(join(ROOT, path)))).toBe(blob);
  });

  it("the #290 Inc 1 re-pin is outside the unchanged map, and the pinned set is the same 28 files", () => {
    const all = [...Object.keys(UNCHANGED_AT_9ECA1E3), ...Object.keys(CHANGED_BY_290_INC1_READABLE_GATE_OPTION)];
    expect(Object.keys(UNCHANGED_AT_9ECA1E3)).not.toContain("components/adaptive/ReviewGovernanceSection.tsx");
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(28);
  });
});

/**
 * Owner order C3 (review of cf74a52): the PDF / DOCX composers changed ONLY by the listed edits. Reverting exactly these
 * edits in the current source must reproduce the 9eca1e3 blob byte for byte — so any other change to a frozen export
 * composer (a provenance read, an import, a recomputation, a reworded literal) fails here even though the pin above was
 * re-recorded.
 */
const C3_COMMENT_PDF =
  "  // An unmarked report whose top claim's supporting slots are not independent executing models: the verdict section is\n  // headed by what it counts (exportPositionView.ts); every other unmarked report composes exactly as before.\n";
const C3_COMMENT_DOCX =
  "  // An unmarked report whose top claim's supporting slots are not independent executing models: the verdict section is\n  // headed by what it counts (exportPositionView.ts); every other unmarked report exports exactly as before.\n";
/**
 * c16 (review of 48f3739, MAJOR-2 — the same controlled exception): ONLY the report status summary's level, which is
 * labelled as the verification gate (the marked report's existing relabel, MARKED_GATE_LEVEL_*) also when the exported
 * run's slots are not independent executing models or its execution is not recorded (exportRunIndependence, from
 * exportPositionView.ts); the import of that one function; no provenance read, no other literal. Listed first: reverting
 * them gives the 48f3739 source, then the C3 edits give 9eca1e3.
 */
const C16_STATUS_COMMENT =
  "  // c16 (MAJOR-2): so is the level of a report whose run's slots are not independent executing models, or whose\n  // execution is not recorded (a pre-6.2b export) — never a \"Strong consensus\" tier.\n";
const C16_IMPORT: [string, string] = [
  'import { exportPositionSafeReport, exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";',
  'import { exportPositionSafeReport } from "@/lib/adaptiveSchema/exportPositionView";',
];
const DS_FROZEN_EXPORT_DIFF: Record<string, { was: string; edits: [current: string, at9eca1e3: string][] }> = {
  "lib/pdf/AdaptiveResearchDocument.tsx": {
    was: "10ba10b9d413214b7e4e00c422f9b15ab640d26a",
    edits: [
      ['import { exportMilestone2SummaryLevel, exportPositionSafeReport, exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";', 'import { exportPositionSafeReport, exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";'],
      ["\n  // Order 31 R-2: a Milestone-2 report has no verification gate — its level is labelled by panel slot instead.\n  const slotLevel = exportMilestone2SummaryLevel(record);", ""],
      ["{slotLevel ? slotLevel.field : gateLevel ? MARKED_GATE_LEVEL_FIELD", "{gateLevel ? MARKED_GATE_LEVEL_FIELD"],
      ["{slotLevel ? slotLevel.word : gateLevel ? MARKED_GATE_LEVEL_WORD", "{gateLevel ? MARKED_GATE_LEVEL_WORD"],
      ["      {slotLevel ? (\n        <Text style={pdfStyles.mutedText}>{slotLevel.note}</Text>\n      ) : gateLevel ? (", "      {gateLevel ? ("],
      C16_IMPORT,
      [`${C16_STATUS_COMMENT}  const gateLevel = isPositionMarked(snapshot.legacy?.synthesisReport) || !!exportRunIndependence(record);`, "  const gateLevel = isPositionMarked(snapshot.legacy?.synthesisReport);"],
      [`${C3_COMMENT_PDF}  const { report: synthesis, view: positions, independence } = exportPositionSafeReport(record);`, "  const { report: synthesis, view: positions } = exportPositionSafeReport(record);"],
      ['<SectionCard label={independence ? independence.sectionHeading : "Where models agree / disagree"}>', '<SectionCard label="Where models agree / disagree">'],
      [
        '<VerdictCardBody verdictCard={synthesis.verdictCard} {...(independence ? { headings: { top: independence.topHeading, key: "Disagreement" } } : {})} />',
        "<VerdictCardBody verdictCard={synthesis.verdictCard} />",
      ],
    ],
  },
  "lib/docx/AdaptiveResearchDocxDocument.ts": {
    was: "4e8ba97ea8d0ad4bc9e13d2a598121da2ff657b0",
    edits: [
      ['import { exportMilestone2SummaryLevel, exportPositionSafeReport, exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";', 'import { exportPositionSafeReport, exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";'],
      [
        '  // Order 31 R-2: a Milestone-2 report has no verification gate — its level is labelled by panel slot instead.\n  const slotLevel = exportMilestone2SummaryLevel(record);\n  if (slotLevel) {\n    return [\n      heading("Report status summary"),\n      ...fieldGrid([\n        ["Models", modelsText || "—"],\n        [slotLevel.field, slotLevel.word],\n        ["Source grounding", SOURCE_GROUNDING_LABELS[snapshot.sourceGroundingLevel]],\n      ]),\n      muted(slotLevel.note),\n    ];\n  }\n',
        "",
      ],
      C16_IMPORT,
      [`${C16_STATUS_COMMENT}  if (isPositionMarked(snapshot.legacy?.synthesisReport) || exportRunIndependence(record)) {`, "  if (isPositionMarked(snapshot.legacy?.synthesisReport)) {"],
      [`${C3_COMMENT_DOCX}  const { report: synthesis, view: positions, independence } = exportPositionSafeReport(record);`, "  const { report: synthesis, view: positions } = exportPositionSafeReport(record);"],
      [
        'out.push(heading(positions ? positions.verdict.sectionHeading : independence ? independence.sectionHeading : "Where models agree / disagree"));',
        'out.push(heading(positions ? positions.verdict.sectionHeading : "Where models agree / disagree"));',
      ],
      [
        'out.push(muted(positions ? positions.verdict.topHeading : independence ? independence.topHeading : "Agreement"), body(top.claim));',
        'out.push(muted(positions ? positions.verdict.topHeading : "Agreement"), body(top.claim));',
      ],
    ],
  },
  // c16 (MAJOR-2): ONLY the consensus field — in a run whose slots are not independent executing models (or whose
  // execution is not recorded; useRunIndependence) a gate-derived level is labelled as the gate, as on a marked report,
  // and a schema-derived level (never Decision Support) as agreement by panel slot. The DS branch, every other field and
  // every independent run are unchanged. Reverting these edits gives the 48f3739 blob (itself pinned at 9eca1e3 above).
  "components/adaptive/TopSummaryBar.tsx": {
    was: "ea8b059bbafe1589fe79f1a3824c298d5a68926b",
    edits: [
      ['import { SLOT_AGREEMENT_FIELD, slotAgreementWord } from "@/lib/adaptiveSchema/verdictIndependence";\nimport { useRunIndependence, useSchemaLevelRunIndependence } from "./useRunIndependence";', 'import { SLOT_AGREEMENT_FIELD, SLOT_AGREEMENT_WORD } from "@/lib/adaptiveSchema/verdictIndependence";\nimport { useRunIndependence } from "./useRunIndependence";'],
      ["  // Order 31 R-3: a schema-derived level is a stored result — no, or fewer than two, answering models make it unavailable.\n  const schemaRun = useSchemaLevelRunIndependence(consensus, runIndependence);\n  const slotLevel = !!schemaRun && schemaLevel", "  const slotLevel = !!runIndependence && schemaLevel"],
      ["{slotAgreementWord(consensus, schemaRun)}", "{SLOT_AGREEMENT_WORD[consensus]}"],
      ['import { SLOT_AGREEMENT_FIELD, SLOT_AGREEMENT_WORD } from "@/lib/adaptiveSchema/verdictIndependence";\nimport { useRunIndependence } from "./useRunIndependence";\n', ""],
      [
        "  // c16 (MAJOR-2): a run whose slots are not independent executing models (or whose execution is not recorded) never\n  // shows a \"Strong / Moderate / Weak consensus\" tier — a gate-derived level is labelled as the gate (as on a marked\n  // report); a schema-derived level as agreement by panel slot. An independent run: exactly as before.\n  const runIndependence = useRunIndependence(props.synthesisReport);\n  const schemaLevel =\n    !!props.comparisonMatrix || !!props.checklistTaxonomy || !!props.decisionSupport || !!props.causalExplanation || !!props.definitionExplanation || !!props.rankedEnumeration || !!props.deepResearch || !!props.evidenceReview || !!props.biasBlindspotAudit;\n  const slotLevel = !!runIndependence && schemaLevel && !isDecisionSupportSchema(schemaId);\n",
        "",
      ],
      ["    (isPositionMarked(props.synthesisReport) || !!runIndependence) &&\n", "    isPositionMarked(props.synthesisReport) &&\n"],
      [
        "        ) : slotLevel ? (\n          <SummaryField label={SLOT_AGREEMENT_FIELD}>\n            <TintBadge tone={LEVEL_TONE[consensus]}>{SLOT_AGREEMENT_WORD[consensus]}</TintBadge>\n          </SummaryField>\n",
        "",
      ],
    ],
  },
};

describe("owner order C3 / c16: the frozen composers and summary bar differ from 9eca1e3 only by the listed independence edits", () => {
  it.each(Object.entries(DS_FROZEN_EXPORT_DIFF))("%s", (path, { was, edits }) => {
    let src = read(path);
    for (const [current, before] of edits) {
      expect([path, src.split(current).length - 1]).toEqual([path, 1]);
      src = src.replace(current, before);
    }
    expect(gitBlob(Buffer.from(src, "utf8"))).toBe(was);
  });
});

const NEW_MODULES = ["components/adaptive/DsProvenanceSection.tsx", "lib/research/dsProvenanceClientView.ts", "lib/adaptiveSchema/dsProvenanceDisplayText.ts"];

describe("the new modules make no request and inject nothing", () => {
  it.each(NEW_MODULES)("%s", (path) => {
    const src = read(path);
    for (const banned of [/\bfetch\s*\(/, /authedFetch/, /process\.env/, /dangerouslySetInnerHTML/, /\bhref\b/, /<a[\s>]/, /from "@\/lib\/env"/, /firebase/i, /localStorage|sessionStorage/]) {
      expect([path, banned.source, banned.test(src)]).toEqual([path, banned.source, false]);
    }
  });

  it("imports are pinned: the parser reads only the sealed builder constants; the section only display text and a type", () => {
    const imports = (path: string) => [...read(path).matchAll(/^import[^;]*?from "([^"]+)";/gms)].map((m) => m[1]).sort();
    expect(imports("lib/research/dsProvenanceClientView.ts")).toEqual(["@/lib/adaptiveSchema/dsProvenanceViewMin"]);
    expect(imports("components/adaptive/DsProvenanceSection.tsx")).toEqual(["@/lib/adaptiveSchema/dsProvenanceDisplayText", "@/lib/research/dsProvenanceClientView", "react"]);
    expect(read("lib/adaptiveSchema/dsProvenanceDisplayText.ts").match(/from "([^"]+)"/g)).toEqual(['from "./dsLabelWording"']);
  });
});

/**
 * Owner §8: the S-2a strings by origin. Every display-text export is a fixed system-authored label (its value written
 * out here); the remaining rendered text is data whose origin is fixed by the mapper.
 */
const SYSTEM_LABELS: Record<string, string> = {
  DS_PROVENANCE_HEADING: "Provenance and review details",
  DS_PROVENANCE_SUMMARY: "Recorded evidence and review details",
  DS_PROVENANCE_SOURCES_LABEL: "Sources",
  DS_SOURCES_LISTED: "Sources listed; not independently verified",
  DS_NO_SOURCES_LISTED: "No sources listed",
  DS_PROVENANCE_UNKNOWN: "Unknown",
  DS_PROVENANCE_STRENGTH_LABEL: "Model-assigned strength",
  DS_STRENGTH_CAPTION: "Evidence-strength ratings are assigned by the models and were not independently checked.",
  DS_PROVENANCE_COUNTS_LABEL: "Model recommendations",
  DS_NOT_A_CERTAINTY_MEASURE: "These counts are not a certainty measure.",
  DS_PROVENANCE_REVIEW_LABEL: "Review status",
  DS_NOT_FLAGGED_FOR_REVIEW: "System did not flag this for human review.",
  DS_PROVENANCE_FLAGGED_FOR_REVIEW: "Flagged for human review",
  DS_PROVENANCE_REVIEW_RECORDED: "Review recorded",
  DS_PROVENANCE_REVIEWED_AT_LABEL: "Reviewed at",
  DS_PROVENANCE_CONDITIONS_LABEL: "Review conditions",
  DS_PROVENANCE_USE_LABEL: "Use authorization",
  DS_PROVENANCE_NOT_AUTHORIZED_FOR_USE: "Not authorized for use",
  DS_PROVENANCE_EMPTY: "No provenance or review details recorded",
};
const DATA_ORIGINS = {
  "sources.items": "model-authored source material (model-listed, not checked)",
  conditions: "reviewer-authored conditions (as recorded on the decision)",
  counts: "system-recorded state (the approved D-2 sentence over the result's recorded counts)",
  reviewedAt: "system-recorded state (the recorded decision time, formatted in UTC)",
} as const;

describe("S-2a display vocabulary (classified by origin)", () => {
  it("the display-text module exports exactly the approved system labels", () => {
    expect({ ...DisplayText }).toEqual(SYSTEM_LABELS);
  });
  it("no system label states agreement, verification, certainty or authorization (only the approved negations and the neutral heading)", () => {
    const NEGATIONS = ["not independently verified", "Not authorized for use", "not a certainty measure", "Use authorization"];
    const RISKY = /agree|consensus|unanim|converg|genuine|verif|authoriz|certain|confiden|approv/i;
    for (const [k, v] of Object.entries(SYSTEM_LABELS)) {
      const rest = NEGATIONS.reduce((t, n) => t.split(n).join(" "), v);
      expect([k, RISKY.test(rest)]).toEqual([k, false]);
    }
  });
  it("every data-supplied string has a stated origin", () => {
    expect(Object.keys(DATA_ORIGINS).sort()).toEqual(["conditions", "counts", "reviewedAt", "sources.items"]);
  });
});
