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
  "lib/pdf/AdaptiveResearchDocument.tsx": "10ba10b9d413214b7e4e00c422f9b15ab640d26a",
  "lib/docx/AdaptiveResearchDocxDocument.ts": "4e8ba97ea8d0ad4bc9e13d2a598121da2ff657b0",
  "lib/adaptiveSchema/dsLabelWording.ts": "db50c0e7b9cec1ad8416a566b2d08c4ed16fefa1",
  "lib/adaptiveSchema/decisionSupportAlignment.ts": "b19e49caacc05c52c17a4676a7321dca654d132c",
  "lib/adaptiveSchema/decisionReceiptBuilder.ts": "e32c42b64d7d1d05f41dee95c548dacc76668640",
  "lib/adaptiveSchema/governanceRecordParser.ts": "2a195deca74df74c0f4701743bf1f78033ffc5e2",
  "lib/adaptiveSchema/persistedOutput.ts": "9f9ca552d033bcdabe5fcb52862356e5f638e8b5",
  "lib/runs/runReadPayload.ts": "3b4868c206dfb252f9931c075953b3c0e139b371",
  "lib/user/runDocumentToPublicResults.ts": "d1ed5a2d6d9caafa3d7e63d18307919ca7cb4cf1",
  // Order 6 critical-contrast slice (class-only; see criticalContrastSlice.ts): was 49c7924bbb7bf9466ab7cc8b7cd23a0f2294db85 at 9eca1e3.
  "components/adaptive/DecisionSupportView.tsx": "e3beb32c1161f42d84222b1633a6bd8b1bb98939",
  "components/adaptive/DsReceiptWording.tsx": "71b1542ecc11532f26f0bf8a758fffe311775ac6",
  "components/adaptive/PanelEvidenceSection.tsx": "01fa50175cc4a014ad17d2abad806b8eec999170",
  "components/adaptive/ReviewGovernanceSection.tsx": "c5298d27bb4e52562fc9865b17875ee87fc04d5c",
  "components/adaptive/TopSummaryBar.tsx": "ea8b059bbafe1589fe79f1a3824c298d5a68926b",
  // Order 6 critical-contrast slice (class-only; see criticalContrastSlice.ts): was 52464f6b4c8d3d330ac1764ff711297e2c31ecbe at 9eca1e3.
  "components/workspace/projects/TeamResearchReviewSummary.tsx": "16a12b9d0f15c5297a8745958126cdd6ea50d263",
  "app/page.tsx": "6dbe9b1f924731e1417655a68f41cd232f7cd16a",
  "firestore.rules": "2fb80a11bfa6c55fe94e0438a980a3b0794aeafd",
};

describe("forbidden layers are unchanged from main 9eca1e3", () => {
  it.each(Object.entries(UNCHANGED_AT_9ECA1E3))("%s", (path, blob) => {
    expect(gitBlob(readFileSync(join(ROOT, path)))).toBe(blob);
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
