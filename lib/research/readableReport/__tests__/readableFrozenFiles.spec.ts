/**
 * #290 Increment 1 — the files this increment must not change, pinned to their git blob ids (32 files).
 *
 * UNCHANGED_AT_35933C8 (blob ids at origin/main 35933c8): the sealed parity oracles and their fixtures (historicalParity,
 * nonDsWordingParity, vocabularyInventory), the frozen wording modules shared with exports and persisted report text
 * (reportSummary, agreementNarrative, reportPresentation, positionPresentation, gatePresentation, trustSummary,
 * exportSnapshot), the PDF / DOCX composers, the classic strip and summary bar, lib/env.ts and the live composer. A
 * readable-layout change that touched any of them would fail here before review. Readable additions live in new files.
 *
 * The owner-authorized exceptions are pinned to their exact new content, each with its reason, in WIDENED_BY_INC1
 * (vocabulary scanner and manifest) and READABLE_GATE_OPTION_BY_INC1 (AdaptiveSynthesisReportView.tsx,
 * dsProvenanceUiBoundaries.spec.ts and — since 7212c47 — shareBuilders.ts, which is no longer pinned at 35933c8: it takes
 * the optional readable-only ReadableShareGate; its classic output is held byte-identical by the frozen parity digests in
 * components/research/readable/__tests__/readableShareGate.spec.tsx).
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const gitBlob = (data: Buffer) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");

/**
 * CONNECTOR INTEGRATION RE-PIN (Order 34, owner-approved integration of the accepted connector heads C-a 972fd29, C-b
 * dd4cdcd, C-c c16ef7c into main 2cd71bb; register in ConvergePanel-Deployment-Evidence/2026-11-10-order34/integration).
 * The connector track legitimately changed 14 of the files pinned below (owner-authorized presentation changes: model
 * independence wording, panel-slot counts, substituted-slot attribution, D-5 placeholders). Ten are byte-identical to the
 * accepted connector head; four (AdaptiveSynthesisReportView.tsx, shareBuilders.ts, dsProvenanceUiBoundaries.spec.ts,
 * vocabularyManifest.json) are the conflict-resolved merge of both parents (readable gate option kept, connector rules on
 * top). Each pin below that moved is re-recorded to the merged content; map names are kept for continuity — "unchanged"
 * here means unchanged by the readable (#290) increment, not by the connector track.
 */
/** `git rev-parse 35933c8:<path>`. */
const UNCHANGED_AT_35933C8: Record<string, string> = {
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/records.json": "322a80a944f4549e49bf45a803f4c623f074ca0e",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/renderHashes.json": "861bec939276e2a9cdc5420c206484fe689d808c",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/renderHashes.UTC.json": "d5f5560efb995baab83bdc0d4577b9588f6b4090",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/builderHashes.json": "060ab7e2d9cc3bc3ad7e2288766347315262ea3a",
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/sharedMemos.json": "8ac7d5882ea2b67d0169677337c242e98d5f052c",
  "components/adaptive/__tests__/seSurfaces/__fixtures__/nonDsBaseline.json": "0d51dfacc64e8450de5ee8828b20cb9e4ffcea1f",
  "lib/adaptiveSchema/__tests__/o5p/o5pRender.ts": "d8dc0f262634d3d5afb4941fc9cab08be190adb9",
  "lib/adaptiveSchema/__tests__/o5p/o5pScenarios.ts": "d3e0ec5beb38d7eec80f76f2caf91bf275f65b85",
  "lib/adaptiveSchema/__tests__/o5p/vocabularyInventory.spec.ts": "d2bc041abf55fa88066faf9a2cda5b774f1d3b14",
  "components/adaptive/__tests__/nonDsWordingParity.spec.tsx": "5ff413cb8365ba413c600a043895ba55fc0d9014",
  "components/adaptive/__tests__/adaptiveAncillaryStructure.spec.ts": "cfab55ca124c4f918149df06901285390134745b",
  "lib/env.ts": "2b81ae7239ea4fd655b8320d5bf726c778149a20",
  "components/adaptive/TopSummaryBar.tsx": "0617d5ca9a3be1e6768655107de2b38a512f72eb",
  "components/adaptive/PrimarySynthesisStrip.tsx": "6c9ef7c8f6a4ee5b0137b943d9c16938ea9cd586",
  "components/adaptive/AnalysisAvailabilityNotice.tsx": "0886deb1b4828f5ea0d1995fe8efc4eaec2a5892",
  "lib/adaptiveSchema/reportSummary.ts": "3ba976c88335c289f335d94776061d765d5a9361",
  "lib/adaptiveSchema/reportStatus.ts": "52f0de27b3a7a790854b27c50e948e39dc73dde7",
  "lib/adaptiveSchema/agreementNarrative.ts": "98e8ecf75fc1e147e3a40f7e134fb63caa64f83a",
  "lib/adaptiveSchema/reportPresentation.ts": "7982bddd87377876ea8e53935547a5ba14a5801b",
  "lib/adaptiveSchema/positionPresentation.ts": "7265fe7440c4171284c56676c9098d7d9d33a6d8",
  "lib/adaptiveSchema/gatePresentation.ts": "512a9d51e95feb8982e60a93832cdac94eee1d9f",
  "lib/adaptiveSchema/trustSummary.ts": "dc6ea9e337a8ae9851559f6d035fc7664422526e",
  "lib/adaptiveSchema/exportSnapshot.ts": "5af930878120bbda7ba49ec40045502416859d19",
  "lib/pdf/AdaptiveResearchDocument.tsx": "80e8678d497d7f41a3d7bee48026832f0ec14736",
  "lib/docx/AdaptiveResearchDocxDocument.ts": "d62e84cffefc0a1c7abfb0e42df75ab0f35cf208",
  "app/page.tsx": "8d97e6296c16b9b0a41c30a8311a88e61de9c9a5",
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
  "lib/adaptiveSchema/__tests__/o5p/__fixtures__/vocabularyManifest.json": "d74147abf059576c671fdcc115e809917eb4fa06",
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
 *
 * Re-pinned again (review of 7212c47, MINOR + NIT): on the readable unavailable gate the copied Markdown and the memo lead
 * with the page's banner and stored-text note, before any stored text, and label the stored panel verdict, answer,
 * certainty text and memo assessment "Stored … (historical; inconsistent with recorded inputs)"; ReadableShareGate gains
 * `banner` (the report view already passes it — ReadableGateDisplay carries it — so the view is unchanged); the readable
 * X post fits 280 characters with the brand and the computed result whole (buildReadableXPost).
 *   - shareBuilders.ts: 389ea0cf6ffabbe390ba3fb438e2764c35344f17 → 6ecb19ee8e15e3d4a5cc7d08d7e2793872395ab9. Classic output
 *     byte-identical: the 5,266-output digest at bb4aed5 and the 15,798-output classic digest captured at 7212c47
 *     (records × gate edits × stored / legacy / R5-era × short / long question, builders and classic page) unchanged.
 * AdaptiveSynthesisReportView.tsx stays 24f22d8c; same 32-file pinned set.
 *
 * Re-pinned again (review of 8def047, MINOR — on the readable unavailable gate the copied Markdown reproduced the stored
 * executive summary unlabelled; on legacy records it is often the stored verdict, e.g. "Verification gate: Caution. …" or
 * "Panel could not converge on a reliable answer."): both Markdown paths now label it "Stored executive summary
 * (historical; inconsistent with recorded inputs)", as the answer is. Readable unavailable only.
 *   - shareBuilders.ts: 6ecb19ee8e15e3d4a5cc7d08d7e2793872395ab9 → e4f5188b64d66cdd424ef24a3857e57905b1e9c1. Classic output
 *     byte-identical: 137,760 classic outputs (records × 82 gate edits × 7 shapes × 3 questions × 4 builders) hash-equal
 *     to 8def047, and the frozen classic digests above unchanged.
 * AdaptiveSynthesisReportView.tsx stays 24f22d8c; same 32-file pinned set.
 *
 * Re-pinned (owner-authorized 2026-11-07, Order 18-A — saved-copy retry notice): dsProvenanceUiBoundaries.spec.ts changed
 * only its own lib/runs/runReadPayload.ts pin (2d897bf → ca6e332, notice wording only; no provenance code). The spec's
 * other pins and assertions are unchanged.
 *   - dsProvenanceUiBoundaries.spec.ts: 7ee80b6b52b8c71af0c72e95b52b45e0080058c0 → 4f2991601910578b95cd268cf466beb4e1d3a182.
 * Same 32-file pinned set.
 *
 * Re-pinned (owner-authorized SEC-2 / S4 provider-key boundary, 2026-11-09): dsProvenanceUiBoundaries.spec.ts changed
 * only its own firestore.rules pin (2fb80a1 → 747ccef: deny-only `appConfig/{doc=**}`; no provenance code). The spec's
 * other pins and assertions are unchanged.
 *   - dsProvenanceUiBoundaries.spec.ts: 4f2991601910578b95cd268cf466beb4e1d3a182 → abcee8eca3175d2c718b662a78c4f3796fcfd1f3.
 * Same 32-file pinned set.
 *
 * Re-pinned (owner-authorized F-2, Order 34 connector integration): dsProvenanceUiBoundaries.spec.ts changed only its own
 * lib/user/runDocumentToPublicResults.ts pin (d1ed5a2 → 09f84f9: passthrough of the structured `outputClass` execution
 * fact; no provenance code). The spec's other pins and assertions are unchanged.
 *   - dsProvenanceUiBoundaries.spec.ts: 0bd0750a98b91a3e7aeae202f5dc1e455969cb04 → 1eb15948753574f91c8b949af4a1fbc19e8dd51e.
 * Same 32-file pinned set.
 *
 * Re-pinned (owner-authorized F-1, Order 35 A — the research memo states the verified answering-model count):
 *   - shareBuilders.ts: d34a619d18cf861040516309dc09417045a88ac4 → 3364318bbff38be700ed29b51cb8caf4a1015d84 (buildMemoInput
 *     passes answeringIndependentModelCount when it differs from the slot count; nothing else).
 *   - historicalParity.spec.tsx: moved here from UNCHANGED_AT_35933C8 (eda40eb5583b2c83946f17045ea45f13d0061338 →
 *     fce2e3172049cd868607e83a8a0a0147ec4939f3). Additions only: the exact-hash supersession overlay
 *     (__fixtures__/order35-f1/memoSupersession.json) for text.memo / text.memoInput of factual-single and
 *     generic-substituted-and-failed, and a test that each superseded entry's sealed hash equals the untouched 2c17feee
 *     oracle. The oracle files themselves stay pinned above, unchanged.
 *   - vocabularyManifest.json (WIDENED_BY_INC1): 9774e44bba846e24cc08bcc7f85536eb607a3277 →
 *     5a18983d528bb88c055d0dbff7984b39472e8ef4 (3 entries appended: the zero-response memo literals; none removed).
 * Same 32-file pinned set.
 *
 * Re-pinned (owner-authorized F35-M1, Order 36 A — the marked adaptive memo states no run certainty with fewer than two
 * verified independent successful responses):
 *   - shareBuilders.ts: 3364318bbff38be700ed29b51cb8caf4a1015d84 → f5e67a0a0ee20e2da15917b2a2f195005943f1ba (the marked
 *     branch passes the verified count 0 / 1, or identity-unverified; nothing else).
 *   - vocabularyManifest.json: 5a18983d528bb88c055d0dbff7984b39472e8ef4 → d74147abf059576c671fdcc115e809917eb4fa06 (3
 *     entries appended: the marked memo's insufficient-evidence literals; none removed).
 * Same 32-file pinned set.
 *
 * Re-pinned (owner-authorized Order 40 C, adopted-retry persistence #313): dsProvenanceUiBoundaries.spec.ts changed only its
 * own lib/runs/runReadPayload.ts pin (ca6e332 → ac10d54: the verified saved adopted results feed adaptive.modelResults
 * only; no provenance code). The spec's other pins and assertions are unchanged.
 *   - dsProvenanceUiBoundaries.spec.ts: 1eb15948753574f91c8b949af4a1fbc19e8dd51e → 98e4920e7810a5e4a458a4ad71185c17a7041d2f.
 * Same 32-file pinned set.
 *
 * Re-pinned (owner-authorized Order 40 C O-2 correction, separate display document): dsProvenanceUiBoundaries.spec.ts
 * changed only its own pins for the two read routes and runReadPayload.ts (the display record is loaded from its own
 * document after the routes' gates and passed in). The spec's other pins and assertions are unchanged.
 *   - dsProvenanceUiBoundaries.spec.ts: 98e4920e7810a5e4a458a4ad71185c17a7041d2f → c0774a6d0452c69795fd49442091d78f3cb8112d.
 * Same 32-file pinned set.
 */
const READABLE_GATE_OPTION_BY_INC1: Record<string, string> = {
  "components/adaptive/AdaptiveSynthesisReportView.tsx": "bcdf6ba2444c2aa3dc22ae049901cf72e55eb0bc",
  "components/adaptive/__tests__/dsProvenanceUiBoundaries.spec.ts": "c0774a6d0452c69795fd49442091d78f3cb8112d",
  "lib/adaptiveSchema/shareBuilders.ts": "f5e67a0a0ee20e2da15917b2a2f195005943f1ba",
  "lib/adaptiveSchema/__tests__/o5p/historicalParity.spec.tsx": "fce2e3172049cd868607e83a8a0a0147ec4939f3",
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
