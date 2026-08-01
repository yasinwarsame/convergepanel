import {
  nextSessionSyncState,
  canPerformProtectedMutation,
  NON_MUTABLE_SYNC_STATES,
  type SessionSyncState,
} from "@/lib/client/authSessionStateMachine";

const ALL_STATES: SessionSyncState[] = [
  "signed_out",
  "authenticating",
  "syncing_session",
  "authenticated",
  "signing_out",
  "session_error",
];

describe("nextSessionSyncState", () => {
  it("login_attempt_started always moves to authenticating", () => {
    for (const state of ALL_STATES) {
      expect(nextSessionSyncState(state, { type: "login_attempt_started" })).toBe("authenticating");
    }
  });

  it("client_signed_in always moves to syncing_session, from ANY state — this is what makes a direct account switch (no explicit logout) safe", () => {
    for (const state of ALL_STATES) {
      expect(nextSessionSyncState(state, { type: "client_signed_in", uid: "u1" })).toBe("syncing_session");
    }
  });

  it("client_signed_out always moves to signed_out, from ANY state — the previous identity is never retained", () => {
    for (const state of ALL_STATES) {
      expect(nextSessionSyncState(state, { type: "client_signed_out" })).toBe("signed_out");
    }
  });

  it("session_sync_started only stays syncing_session from syncing_session, otherwise fails closed to session_error", () => {
    expect(nextSessionSyncState("syncing_session", { type: "session_sync_started" })).toBe("syncing_session");
    for (const state of ALL_STATES.filter((s) => s !== "syncing_session")) {
      expect(nextSessionSyncState(state, { type: "session_sync_started" })).toBe("session_error");
    }
  });

  it("session_sync_succeeded only reaches authenticated from syncing_session", () => {
    expect(nextSessionSyncState("syncing_session", { type: "session_sync_succeeded" })).toBe("authenticated");
    for (const state of ALL_STATES.filter((s) => s !== "syncing_session")) {
      expect(nextSessionSyncState(state, { type: "session_sync_succeeded" })).toBe("session_error");
    }
  });

  it("session_sync_failed always fails closed to session_error, from ANY state", () => {
    for (const state of ALL_STATES) {
      expect(nextSessionSyncState(state, { type: "session_sync_failed" })).toBe("session_error");
    }
  });

  it("token_refresh_started/succeeded only stay authenticated from authenticated, otherwise fail closed", () => {
    expect(nextSessionSyncState("authenticated", { type: "token_refresh_started" })).toBe("authenticated");
    expect(nextSessionSyncState("authenticated", { type: "token_refresh_succeeded" })).toBe("authenticated");
    for (const state of ALL_STATES.filter((s) => s !== "authenticated")) {
      expect(nextSessionSyncState(state, { type: "token_refresh_started" })).toBe("session_error");
      expect(nextSessionSyncState(state, { type: "token_refresh_succeeded" })).toBe("session_error");
    }
  });

  it("token_refresh_failed never retains the previous authenticated state — always fails closed", () => {
    for (const state of ALL_STATES) {
      expect(nextSessionSyncState(state, { type: "token_refresh_failed" })).toBe("session_error");
    }
  });

  it("logout_started always moves to signing_out, from ANY state", () => {
    for (const state of ALL_STATES) {
      expect(nextSessionSyncState(state, { type: "logout_started" })).toBe("signing_out");
    }
  });

  it("logout_completed always moves to signed_out, from ANY state", () => {
    for (const state of ALL_STATES) {
      expect(nextSessionSyncState(state, { type: "logout_completed" })).toBe("signed_out");
    }
  });

  it("error_acknowledged clears session_error to signed_out, and is a no-op from every other state", () => {
    expect(nextSessionSyncState("session_error", { type: "error_acknowledged" })).toBe("signed_out");
    for (const state of ALL_STATES.filter((s) => s !== "session_error")) {
      expect(nextSessionSyncState(state, { type: "error_acknowledged" })).toBe(state);
    }
  });

  it("an unrecognized event type fails closed to session_error", () => {
    // @ts-expect-error deliberately malformed event for the fail-closed default branch
    expect(nextSessionSyncState("authenticated", { type: "not_a_real_event" })).toBe("session_error");
  });
});

describe("canPerformProtectedMutation / NON_MUTABLE_SYNC_STATES", () => {
  it("is true ONLY for authenticated", () => {
    for (const state of ALL_STATES) {
      expect(canPerformProtectedMutation(state)).toBe(state === "authenticated");
    }
  });

  it("NON_MUTABLE_SYNC_STATES contains every state except authenticated, and nothing else", () => {
    for (const state of ALL_STATES) {
      expect(NON_MUTABLE_SYNC_STATES.has(state)).toBe(state !== "authenticated");
    }
    expect(NON_MUTABLE_SYNC_STATES.size).toBe(ALL_STATES.length - 1);
  });
});
