/**
 * Evidence Workspace, Phase 11A.4 — proves `buildOriginLinkedVerifyClaimRequestBody()`
 * is exactly the choke point it claims to be: exactly three keys, always
 * `runId`/`claimId`/`models`, never a `claim`/`projectId`/`origin` key
 * under any circumstance.
 */

import { buildOriginLinkedVerifyClaimRequestBody } from "@/lib/verification/originLinkedVerifyClaimRequest";

describe("buildOriginLinkedVerifyClaimRequestBody", () => {
  it("returns exactly runId, claimId, and models — no other keys", () => {
    const body = buildOriginLinkedVerifyClaimRequestBody({
      runId: "run-1",
      claimId: "v1:findings:0:" + "a".repeat(43),
      models: ["claude", "chatgpt"],
    });
    expect(Object.keys(body).sort()).toEqual(["claimId", "models", "runId"]);
  });

  it("passes runId/claimId/models through verbatim", () => {
    const claimId = "v1:findings:2:" + "b".repeat(43);
    const body = buildOriginLinkedVerifyClaimRequestBody({ runId: "run-xyz", claimId, models: ["gemini", "grok", "perplexity"] });
    expect(body).toEqual({ runId: "run-xyz", claimId, models: ["gemini", "grok", "perplexity"] });
  });

  it("never includes a claim key, even if the caller's args object happens to carry extra properties", () => {
    const argsWithExtra = {
      runId: "run-1",
      claimId: "v1:findings:0:" + "c".repeat(43),
      models: ["claude", "chatgpt"],
      claim: "This should never survive into the request body.",
    };
    const body = buildOriginLinkedVerifyClaimRequestBody(argsWithExtra as any);
    expect(Object.prototype.hasOwnProperty.call(body, "claim")).toBe(false);
  });

  it("never includes a projectId or origin key", () => {
    const body = buildOriginLinkedVerifyClaimRequestBody({ runId: "run-1", claimId: "v1:findings:0:" + "d".repeat(43), models: ["claude"] });
    expect(Object.prototype.hasOwnProperty.call(body, "projectId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "origin")).toBe(false);
  });
});
