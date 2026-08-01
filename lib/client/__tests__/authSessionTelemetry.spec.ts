import { logAuthSessionClientEvent } from "@/lib/client/authSessionTelemetry";

describe("logAuthSessionClientEvent", () => {
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("logs failure-category events via console.warn with only safe metadata", () => {
    logAuthSessionClientEvent("session_identity_mismatch", { route: "/api/auth/session" });
    expect(warnSpy).toHaveBeenCalledWith("[auth-session] session_identity_mismatch", { operation: "session_identity_mismatch", route: "/api/auth/session" });
  });

  it("session_sync_failed and logout_clear_failed are also treated as failures (console.warn, always emitted)", () => {
    logAuthSessionClientEvent("session_sync_failed", { failureCategory: "network_error" });
    logAuthSessionClientEvent("logout_clear_failed", { failureCategory: "http_500" });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("never throws even if console itself is unavailable", () => {
    warnSpy.mockImplementation(() => {
      throw new Error("console blocked");
    });
    expect(() => logAuthSessionClientEvent("session_identity_mismatch", {})).not.toThrow();
  });

  it("the metadata shape carries no uid/email/token/cookie/claim field", () => {
    logAuthSessionClientEvent("session_cleared", { route: "/api/auth/session", operationGeneration: 7 });
    const lastCall = warnSpy.mock.calls[0] ?? infoSpy.mock.calls[0];
    if (lastCall) {
      const metadata = lastCall[1];
      expect(Object.keys(metadata)).not.toEqual(expect.arrayContaining(["uid", "email", "token", "cookie", "claims"]));
    }
  });
});
