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

describe("Stage 0 F3 — token_refresh_deferred", () => {
  it("keeps authenticated ONLY when already authenticated; every other state becomes session_error (never an upgrade)", () => {
    const { nextSessionSyncState: next } = jest.requireActual("@/lib/client/authSessionStateMachine");
    expect(next("authenticated", { type: "token_refresh_deferred" })).toBe("authenticated");
    for (const s of ["signed_out", "authenticating", "syncing_session", "signing_out", "session_error"]) {
      expect(next(s, { type: "token_refresh_deferred" })).toBe("session_error");
    }
  });
});

describe("ZCA P3 R2 MB(c) — the transitions cancelLogout relies on are unchanged", () => {
  const { nextSessionSyncState: next } = jest.requireActual("@/lib/client/authSessionStateMachine");
  const REFRESH = ["token_refresh_started", "token_refresh_succeeded", "token_refresh_failed", "token_refresh_deferred"] as const;
  it("no token_refresh_* event ever upgrades syncing_session or signing_out", () => {
    for (const from of ["syncing_session", "signing_out"]) {
      for (const type of REFRESH) {
        const to = next(from, { type });
        expect([from, type, to]).toEqual([from, type, "session_error"]);
      }
    }
  });
  it("ONLY session_sync_succeeded from syncing_session reaches authenticated (exhaustive over every state × event but the authenticated self-loops)", () => {
    const STATES = ["signed_out", "authenticating", "syncing_session", "authenticated", "signing_out", "session_error"];
    const EVENTS = [
      { type: "login_attempt_started" }, { type: "client_signed_in", uid: "u" }, { type: "client_signed_out" }, { type: "session_sync_started" },
      { type: "session_sync_succeeded" }, { type: "session_sync_failed" }, ...REFRESH.map((type) => ({ type })),
      { type: "logout_started" }, { type: "logout_completed" }, { type: "error_acknowledged" },
    ];
    const reaching: string[] = [];
    for (const s of STATES) for (const e of EVENTS) if (s !== "authenticated" && next(s, e) === "authenticated") reaching.push(`${s} + ${e.type}`);
    expect(reaching).toEqual(["syncing_session + session_sync_succeeded"]);
  });
  it("cancelLogout's re-entry path: signing_out --client_signed_in--> syncing_session --session_sync_started--> syncing_session --session_sync_succeeded--> authenticated", () => {
    let s = next("signing_out", { type: "client_signed_in", uid: "u" });
    expect(s).toBe("syncing_session");
    s = next(s, { type: "session_sync_started" });
    expect(s).toBe("syncing_session");
    expect(next(s, { type: "session_sync_succeeded" })).toBe("authenticated");
  });
});
