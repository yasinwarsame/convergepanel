/**
 * #290 Increment 1 — the files this increment must not change, pinned to their git blob ids at origin/main 35933c8.
 *
 * The sealed parity oracles and their fixtures (historicalParity, nonDsWordingParity, vocabularyInventory), the frozen
 * wording modules shared with exports and persisted report text (reportSummary, agreementNarrative, reportPresentation,
 * positionPresentation, gatePresentation, trustSummary, shareBuilders, exportSnapshot), the PDF / DOCX composers, the
 * classic strip and summary bar, lib/env.ts and the live composer. A readable-layout change that touched any of them
 * would fail here before review. Readable additions live in new files only.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const gitBlob = (data: Buffer) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");

/** `git rev-parse 35933c8:<path>`. */
const UNCHANGED_AT_35933C8: Record<string, string> = {
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/records.json": "322a80a944f4549e49bf45a803f4c623f074ca0e",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/renderHashes.json": "861bec939276e2a9cdc5420c206484fe689d808c",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/renderHashes.UTC.json": "d5f5560efb995baab83bdc0d4577b9588f6b4090",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/builderHashes.json": "060ab7e2d9cc3bc3ad7e2288766347315262ea3a",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/sharedMemos.json": "8ac7d5882ea2b67d0169677337c242e98d5f052c",
  "components/adaptive/__tests__/seSurfaces/__fixtures__/nonDsBaseline.json": "0d51dfacc64e8450de5ee8828b20cb9e4ffcea1f",
  "lib/adaptiveSchema/__tests__/o5p/historicalParity.spec.tsx": "c699f3686c36a2cd576d3d7bcef66fa570788f9f",
  "lib/adaptiveSchema/__tests__/o5p/o5pRender.ts": "453cffb18b9cfd9c66f8766b27d3e74e4e8cfe68",
  "lib/adaptiveSchema/__tests__/o5p/o5pScenarios.ts": "d3e0ec5beb38d7eec80f76f2caf91bf275f65b85",
  "lib/adaptiveSchema/__tests__/o5p/vocabularyInventory.spec.ts": "d2bc041abf55fa88066faf9a2cda5b774f1d3b14",
  "components/adaptive/__tests__/nonDsWordingParity.spec.tsx": "5ff413cb8365ba413c600a043895ba55fc0d9014",
  "components/adaptive/__tests__/adaptiveAncillaryStructure.spec.ts": "cfab55ca124c4f918149df06901285390134745b",
  "lib/env.ts": "2b81ae7239ea4fd655b8320d5bf726c778149a20",
  "components/adaptive/TopSummaryBar.tsx": "ea8b059bbafe1589fe79f1a3824c298d5a68926b",
  "components/adaptive/PrimarySynthesisStrip.tsx": "61d4e96c83ef380a164cf9ac4ce69ed187ade8b0",
  "components/adaptive/AnalysisAvailabilityNotice.tsx": "0886deb1b4828f5ea0d1995fe8efc4eaec2a5892",
  "lib/adaptiveSchema/reportSummary.ts": "3ba976c88335c289f335d94776061d765d5a9361",
  "lib/adaptiveSchema/reportStatus.ts": "52f0de27b3a7a790854b27c50e948e39dc73dde7",
  "lib/adaptiveSchema/agreementNarrative.ts": "98e8ecf75fc1e147e3a40f7e134fb63caa64f83a",
  "lib/adaptiveSchema/reportPresentation.ts": "842f4d04595914652e5aaf6cd0c4bc1e5b509edd",
  "lib/adaptiveSchema/positionPresentation.ts": "b8d05a23b3d19b260e3fc617db7ebe0ee87e7d69",
  "lib/adaptiveSchema/gatePresentation.ts": "001454f32aae050f8e42ff269ba8873dba1a3ee6",
  "lib/adaptiveSchema/trustSummary.ts": "dc6ea9e337a8ae9851559f6d035fc7664422526e",
  "lib/adaptiveSchema/exportSnapshot.ts": "5af930878120bbda7ba49ec40045502416859d19",
  "lib/pdf/AdaptiveResearchDocument.tsx": "10ba10b9d413214b7e4e00c422f9b15ab640d26a",
  "lib/docx/AdaptiveResearchDocxDocument.ts": "4e8ba97ea8d0ad4bc9e13d2a598121da2ff657b0",
  "app/page.tsx": "6dbe9b1f924731e1417655a68f41cd232f7cd16a",
};

/**
 * The vocabulary gate, widened by #290 Inc 1 (review MAJOR-2) to scan the readable modules: SCANNED_ROOTS gains
 * lib/research/readableReport and components/research/readable, and the manifest gains one classified entry per new
 * readable literal (appended; no existing entry changed). Was vocabularyScanner 1be4e9a4, manifest 3c2add10 at 35933c8.
 *
 * Widened again (owner-authorized, review of 28f770c MINOR — the readable Pass banner's "matched" passed the gate
 * unseen): VOCAB gains match\w*, identical, uniform\w*, harmon\w*, coincid\w*, confirm\w*, "same position(s)",
 * "in line with" and "in accord…" ("verif\w*" deliberately not: see the scanner's comment), and the manifest gains one
 * classified entry per newly seen literal, plus the three rewritten readable legacy gate banner literals (appended; no
 * existing entry changed; the 28f770c banner literals had no entry). Scanner a8f3ecf08d12b20fa58cb622b6d03a62a0d1c7ef →
 * cf275d0fb2a80bf99b5f0f707a508103b40054bc; manifest c16cc1f5e78d781b9f71fefe8b5493416dc940a0 →
 * 84d1674780ec5b99c8a38edd91e8c1c34cbd4c6d (328 → 346 entries). Same two files pinned; pinned to the exact new content.
 *
 * Re-pinned again (owner-authorized, review of cb2febb): MAJOR — the readable legacy gate banner no longer restates
 * gate.ts's rule (its three literals replaced by "Verification gate: <word>. This is a rule-based check …" plus the
 * Unavailable banner for a stored gate that contradicts its recorded inputs: 3 entries removed, 4 appended); NIT — VOCAB
 * stems widened (identical\w*, "same stance(s)", consistent, equivalen\w*, concordan\w*), 2 newly seen literals
 * classified (schemaRegistry prompt; generateMemo video verdict — neither is agreement between models). Scanner
 * cf275d0fb2a80bf99b5f0f707a508103b40054bc → 37e23190b3585eaa57fa0ddad29c5b6d01d2f76f; manifest
 * 84d1674780ec5b99c8a38edd91e8c1c34cbd4c6d → 7573b80eb23f9a492076da23a295a1619ed5109c (346 → 349 entries). Same two
 * files pinned (set size unchanged).
 */
const WIDENED_BY_INC1: Record<string, string> = {
  "lib/adaptiveSchema/__tests__/o5p/vocabularyScanner.ts": "37e23190b3585eaa57fa0ddad29c5b6d01d2f76f",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/vocabularyManifest.json": "7573b80eb23f9a492076da23a295a1619ed5109c",
};

/**
 * Owner-authorized narrow exception (Option A, 2026-11-05; review R4 NOT CLEAN on 2335b42 — legacy "Verified — panel
 * converges" banner on the readable page). Moved here from UNCHANGED_AT_35933C8 (the pinned set is the same files), pinned
 * to the exact new content:
 *   - AdaptiveSynthesisReportView.tsx: GateBanner takes an optional readable-only `legacyLabels`, and the report view an
 *     optional `legacyGateBannerLabels` it hands to its banner. Absent (every classic caller), the banner is
 *     gateBannerText's, byte for byte — historicalParity / nonDsWordingParity and their fixtures above are unchanged.
 *     Was 7f31cd2839a32b78053a273a5faebc7165ef6433 at 35933c8.
 *   - dsProvenanceUiBoundaries.spec.ts: its own ReviewGovernanceSection.tsx pin re-pinned (same prop threading), with
 *     the reason recorded beside it. Was dd7e6f6083724c775debfd7551ccbcacbb9ea647 at 35933c8. Review of 28f770c (NIT):
 *     that re-pin moved out of UNCHANGED_AT_9ECA1E3 into its own CHANGED_BY_290_INC1_READABLE_GATE_OPTION map (same
 *     file, same blob, same 28-file pin set): d6368241dcf506a06f78a7d4590c506acda52341 → cb61bde9f1efff29e0f908cbb6810620d39afa47.
 * gatePresentation.ts (LEGACY_GATE_BANNER_LABEL) stays pinned unchanged above.
 *
 * Re-pinned again (owner ruling on review of 082a2a7 NOT CLEAN, MINOR-1/MINOR-2 — narrow readable-only exception for the
 * verification banner, the Panel Verdict display and the Model Responses gate badge): every readable gate display now
 * reads ONE presentation (trustSignals.readableGatePresentation, computed once per page), so an inconsistent legacy record
 * is neutral and "Unavailable" on the banner (words and tone), both Panel Verdict badges and accents and the list badge.
 *   - AdaptiveSynthesisReportView.tsx: LegacyGateBannerLabels / legacyGateBannerOverride replaced by the optional
 *     readable-only `ReadableGateDisplay` (GateBanner `readable`, PanelVerdictCard `readable`, report view
 *     `readableGate`). Absent (every classic caller), the banner, badge and accent are gatePresentation's, byte for byte.
 *     78bc669a7da2f59c078bd7841be28bf76bf5e696 → 486dbcd342baddd5eb285e5ec6acef6ddd1841fa.
 *   - dsProvenanceUiBoundaries.spec.ts: its ReviewGovernanceSection.tsx pin re-pinned for the same prop threading (reason
 *     recorded beside it). cb61bde9f1efff29e0f908cbb6810620d39afa47 → 7ee80b6b52b8c71af0c72e95b52b45e0080058c0.
 * Same two files, same 32-file pinned set; gatePresentation.ts, gate.ts and the parity oracles stay pinned unchanged.
 *
 * Re-pinned again (review of bb4aed5, MINOR — the readable page showed "Unavailable" while its Generate LinkedIn / X
 * post, Copy synthesis and Export memo stated the stored gate, e.g. "(gate: pass)"): the readable report view hands the
 * page's one presentation to the share builders as an explicit optional argument.
 *   - shareBuilders.ts: moved here from UNCHANGED_AT_35933C8 (the pinned set is the same files). Every builder takes an
 *     optional readable-only `ReadableShareGate`; absent (every classic caller), the output is byte-identical — the
 *     builderHashes / sharedMemos oracles above are unchanged, and readableShareGate.spec.tsx's frozen parity digest over
 *     5,266 classic outputs equals the one captured at bb4aed5. Was 4cbba2539d4ee865b2102a2bd9e096344468525e (= 35933c8).
 *   - AdaptiveSynthesisReportView.tsx: its four export actions pass `readableGate` to the builders (classic: undefined).
 *     486dbcd342baddd5eb285e5ec6acef6ddd1841fa → 24f22d8ccd4e97eb762edbbca182bceca3be5c92.
 * Same 32-file pinned set (28 → 27 in UNCHANGED_AT_35933C8 is not a removal: shareBuilders.ts moved to this map).
 */
const READABLE_GATE_OPTION_BY_INC1: Record<string, string> = {
  "components/adaptive/AdaptiveSynthesisReportView.tsx": "24f22d8ccd4e97eb762edbbca182bceca3be5c92",
  "components/adaptive/__tests__/dsProvenanceUiBoundaries.spec.ts": "7ee80b6b52b8c71af0c72e95b52b45e0080058c0",
  "lib/adaptiveSchema/shareBuilders.ts": "389ea0cf6ffabbe390ba3fb438e2764c35344f17",
};

describe("#290 Increment 1 leaves the sealed and frozen files byte-identical to 35933c8", () => {
  it.each(Object.entries(UNCHANGED_AT_35933C8))("%s", (path, blob) => {
    expect(gitBlob(readFileSync(join(process.cwd(), path)))).toBe(blob);
  });

  it.each(Object.entries(WIDENED_BY_INC1))("%s (widened by Inc 1, pinned to its new content)", (path, blob) => {
    expect(gitBlob(readFileSync(join(process.cwd(), path)))).toBe(blob);
  });

  it.each(Object.entries(READABLE_GATE_OPTION_BY_INC1))("%s (readable legacy gate option, pinned to its new content)", (path, blob) => {
    expect(gitBlob(readFileSync(join(process.cwd(), path)))).toBe(blob);
  });

  it("the pinned set is unchanged by the Option A exception: 32 files, no file in two lists", () => {
    const all = [...Object.keys(UNCHANGED_AT_35933C8), ...Object.keys(WIDENED_BY_INC1), ...Object.keys(READABLE_GATE_OPTION_BY_INC1)];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(32);
  });
});
