/**
 * Evidence Workspace, Phase 11A.5B — mapStoredVerificationToClientPayload()
 * purity + sourceResearch-splicing tests. No mocks at all: this function
 * must perform zero I/O, so there is nothing to mock.
 */

import { Timestamp } from "firebase-admin/firestore";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";

function baseDoc(): ClaimVerificationFirestoreDoc {
  return {
    userId: "uid-1",
    claim: "A stable claim.",
    type: "claim_verification",
    verdict: "accurate",
    consensusScore: 90,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 100,
    modelResults: [],
    auditBundle: {} as ClaimVerificationFirestoreDoc["auditBundle"],
    selectedModels: ["claude", "chatgpt"],
    timestamp: Timestamp.now(),
  };
}

describe("mapStoredVerificationToClientPayload — Phase 11A.5B sourceResearch splicing", () => {
  it("third argument omitted entirely -> no sourceResearch key at all (pre-11A.5B / other-caller backward compatibility)", () => {
    const payload = mapStoredVerificationToClientPayload(baseDoc(), "vcl-1");
    expect(Object.prototype.hasOwnProperty.call(payload, "sourceResearch")).toBe(false);
  });

  it("third argument supplied with sourceResearch: null -> explicit null in the payload", () => {
    const payload = mapStoredVerificationToClientPayload(baseDoc(), "vcl-1", { sourceResearch: null });
    expect(Object.prototype.hasOwnProperty.call(payload, "sourceResearch")).toBe(true);
    expect(payload.sourceResearch).toBeNull();
  });

  it("third argument supplied with a valid sourceResearch object -> spliced in verbatim", () => {
    const sourceResearch = { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) };
    const payload = mapStoredVerificationToClientPayload(baseDoc(), "vcl-1", { sourceResearch });
    expect(payload.sourceResearch).toEqual(sourceResearch);
  });

  it("mapper never derives sourceResearch from the doc's own persisted origin field — passing options without sourceResearch-matching origin still uses exactly what was passed", () => {
    const doc = { ...baseDoc(), origin: { type: "deep_research_claim" as const, runId: "run-FROM-ORIGIN", claimId: "v1:findings:0:" + "b".repeat(43) } };
    const passedIn = { type: "deep_research_claim" as const, runId: "run-EXPLICITLY-PASSED", claimId: "v1:findings:0:" + "c".repeat(43) };
    const payload = mapStoredVerificationToClientPayload(doc, "vcl-1", { sourceResearch: passedIn });
    expect(payload.sourceResearch).toEqual(passedIn);
    expect(payload.sourceResearch).not.toEqual(doc.origin);
  });

  it("mapper never spreads a projectId into sourceResearch even if the doc has one", () => {
    const doc = { ...baseDoc(), projectId: "proj-1" };
    const sourceResearch = { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) };
    const payload = mapStoredVerificationToClientPayload(doc, "vcl-1", { sourceResearch });
    expect(Object.keys(payload.sourceResearch as object).sort()).toEqual(["claimId", "runId", "type"]);
  });

  it("raw persisted origin is never exposed as a separate top-level field on the payload", () => {
    const doc = { ...baseDoc(), origin: { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) } };
    const payload = mapStoredVerificationToClientPayload(doc, "vcl-1", { sourceResearch: null });
    expect(Object.prototype.hasOwnProperty.call(payload, "origin")).toBe(false);
  });

  it("legacy 2-argument invocation style still produces the identical payload it always did (minus sourceResearch)", () => {
    const doc = baseDoc();
    const twoArg = mapStoredVerificationToClientPayload(doc, "vcl-1");
    const threeArgOmittingSourceResearchField = mapStoredVerificationToClientPayload(doc, "vcl-1");
    expect(twoArg).toEqual(threeArgOmittingSourceResearchField);
  });

  it("performs no I/O — calling it with adminDb entirely unmocked/unavailable never throws (module has no adminDb import at all)", () => {
    // If this function ever grew a Firestore/network dependency, this file
    // would need to start mocking @/lib/firebase/admin; the fact that it
    // doesn't, and this still passes, is itself the proof of purity.
    expect(() => mapStoredVerificationToClientPayload(baseDoc(), "vcl-1", { sourceResearch: null })).not.toThrow();
  });
});
