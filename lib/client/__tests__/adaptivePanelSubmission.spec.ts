/**
 * Multi-Reviewer Owner Override, Part F (§F18) —
 * mapAdaptivePanelErrorCode() / postAdaptivePanelAction() tests.
 */

import { mapAdaptivePanelErrorCode, postAdaptivePanelAction } from "@/lib/client/adaptivePanelSubmission";

describe("mapAdaptivePanelErrorCode", () => {
  it("maps governance_stale and panel_stale to a stale outcome requiring reload", () => {
    expect(mapAdaptivePanelErrorCode("governance_stale").kind).toBe("stale");
    expect(mapAdaptivePanelErrorCode("panel_stale").kind).toBe("stale");
  });

  it("maps not_pending, panel_cancelled, panel_already_finalized, inconsistent_finalization_state, panel_absent to a terminal outcome", () => {
    for (const code of ["not_pending", "panel_cancelled", "panel_already_finalized", "inconsistent_finalization_state", "panel_absent"]) {
      expect(mapAdaptivePanelErrorCode(code).kind).toBe("terminal");
    }
  });

  it("maps quorum_not_met, panel_deadlocked, vote_already_submitted to a named conflict outcome, preserving the code", () => {
    for (const code of ["quorum_not_met", "panel_deadlocked", "vote_already_submitted"]) {
      const outcome = mapAdaptivePanelErrorCode(code);
      expect(outcome.kind).toBe("conflict");
      if (outcome.kind === "conflict") expect(outcome.code).toBe(code);
    }
  });

  it("maps reviewer_not_assigned, insufficient_role, multi_reviewer_disabled, forbidden to forbidden", () => {
    for (const code of ["reviewer_not_assigned", "insufficient_role", "multi_reviewer_disabled", "forbidden"]) {
      expect(mapAdaptivePanelErrorCode(code).kind).toBe("forbidden");
    }
  });

  it("maps unauthorized to unauthenticated", () => {
    expect(mapAdaptivePanelErrorCode("unauthorized").kind).toBe("unauthenticated");
  });

  it("maps not_found-family codes to not_found", () => {
    for (const code of ["not_found", "projection_missing", "projection_invalid", "governance_record_absent"]) {
      expect(mapAdaptivePanelErrorCode(code).kind).toBe("not_found");
    }
  });

  it("maps firestore_unavailable and unrecognized codes to unavailable, never throwing", () => {
    expect(mapAdaptivePanelErrorCode("firestore_unavailable").kind).toBe("unavailable");
    expect(mapAdaptivePanelErrorCode("some_future_unknown_code").kind).toBe("unavailable");
  });

  it("never returns the raw code as the user-facing message — every message is a fixed literal", () => {
    const outcome = mapAdaptivePanelErrorCode("panel_deadlocked");
    expect(outcome.message).not.toBe("panel_deadlocked");
    expect(outcome.message.length).toBeGreaterThan(0);
  });
});

describe("postAdaptivePanelAction", () => {
  function jsonResponse(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }

  it("returns a success outcome with the parsed body on a 200 ok:true response", async () => {
    const postJson = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true, foo: "bar" }));
    const outcome = await postAdaptivePanelAction("/x", { a: 1 }, postJson);
    expect(outcome).toEqual({ kind: "success", data: { ok: true, foo: "bar" } });
  });

  it("maps a non-ok response's error.code through mapAdaptivePanelErrorCode", async () => {
    const postJson = jest.fn().mockResolvedValue(jsonResponse(409, { ok: false, error: { code: "panel_stale", message: "server detail" } }));
    const outcome = await postAdaptivePanelAction("/x", {}, postJson);
    expect(outcome.kind).toBe("stale");
    if (outcome.kind !== "success") expect(outcome.message).not.toContain("server detail");
  });

  it("returns network_error when the fetch itself throws, never propagating the exception", async () => {
    const postJson = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const outcome = await postAdaptivePanelAction("/x", {}, postJson);
    expect(outcome.kind).toBe("network_error");
    if (outcome.kind !== "success") expect(outcome.message).not.toContain("ECONNRESET");
  });

  it("returns network_error when the response body cannot be parsed as JSON", async () => {
    const postJson = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response);
    const outcome = await postAdaptivePanelAction("/x", {}, postJson);
    expect(outcome.kind).toBe("network_error");
  });

  it("treats a 200 response with ok:false as an error, not a success", async () => {
    const postJson = jest.fn().mockResolvedValue(jsonResponse(200, { ok: false, error: { code: "validation_error" } }));
    const outcome = await postAdaptivePanelAction("/x", {}, postJson);
    expect(outcome.kind).toBe("validation_error");
  });

  it("only ever calls postJson once — no internal retry", async () => {
    const postJson = jest.fn().mockResolvedValue(jsonResponse(409, { ok: false, error: { code: "panel_stale" } }));
    await postAdaptivePanelAction("/x", {}, postJson);
    expect(postJson).toHaveBeenCalledTimes(1);
  });
});
