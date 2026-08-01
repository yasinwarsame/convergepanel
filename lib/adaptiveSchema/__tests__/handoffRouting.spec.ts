/**
 * Query-Routing Redesign, Milestone 1 — handoff behavior.
 *
 * claim_verification and media_authenticity_review are handoff-only
 * intents: no schema body, no answering attempt, no invocation of the
 * dedicated pipelines — just a redirect message naming the right feature.
 */

import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";
import { QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";

function baseClassification(queryType: QueryType): QueryClassification {
  return {
    queryType,
    domain: "test",
    answerShape: "limitation_notice",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "claim_stance_agreement",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test fixture",
    handoffTarget: queryType === "claim_verification" ? "claim_verification" : "video_verification",
  };
}

describe("Claim Verification handoff", () => {
  const routed = routeClassifiedQuery(baseClassification("claim_verification"));

  it("routes to kind 'handoff' with handoffTarget 'claim_verification', never 'active' — invokes zero models", () => {
    expect(routed.kind).toBe("handoff");
    if (routed.kind !== "handoff") throw new Error("unreachable");
    expect(routed.handoffTarget).toBe("claim_verification");
    expect(routed.response.kind).toBe("handoff");
    expect(routed.response.handoffTarget).toBe("claim_verification");
  });

  it("names the Claim Verification workflow explicitly and mentions its distinguishing features", () => {
    if (routed.kind !== "handoff") throw new Error("unreachable");
    const text = routed.response.limitation;
    expect(text).toMatch(/Claim Verification/i);
    expect(text).toMatch(/five models/i);
    expect(text).toMatch(/Verification Gate/i);
    expect(text).toMatch(/Panel Verdict/i);
  });

  it("never mentions Video Verification", () => {
    if (routed.kind !== "handoff") throw new Error("unreachable");
    expect(routed.response.limitation).not.toMatch(/Video Verification/i);
  });
});

describe("Video Verification handoff", () => {
  const routed = routeClassifiedQuery(baseClassification("media_authenticity_review"));

  it("routes to kind 'handoff' with handoffTarget 'video_verification', never 'active' — invokes zero models", () => {
    expect(routed.kind).toBe("handoff");
    if (routed.kind !== "handoff") throw new Error("unreachable");
    expect(routed.handoffTarget).toBe("video_verification");
    expect(routed.response.kind).toBe("handoff");
    expect(routed.response.handoffTarget).toBe("video_verification");
  });

  it("names the Video Verification workflow explicitly and mentions the three-model review", () => {
    if (routed.kind !== "handoff") throw new Error("unreachable");
    const text = routed.response.limitation;
    expect(text).toMatch(/Video Verification/i);
    expect(text).toMatch(/three vision models/i);
  });

  it("never mentions Claim Verification", () => {
    if (routed.kind !== "handoff") throw new Error("unreachable");
    expect(routed.response.limitation).not.toMatch(/Claim Verification/i);
  });
});

describe("Handoff copy is distinct per target", () => {
  it("Claim and Video handoff messages are not the same string", () => {
    const claim = routeClassifiedQuery(baseClassification("claim_verification"));
    const video = routeClassifiedQuery(baseClassification("media_authenticity_review"));
    if (claim.kind !== "handoff" || video.kind !== "handoff") throw new Error("unreachable");
    expect(claim.response.limitation).not.toBe(video.response.limitation);
  });
});
