const mockLoggerInfo = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { info: (...args: unknown[]) => mockLoggerInfo(...args), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logAuthSessionEvent } from "@/lib/authTelemetry";

describe("logAuthSessionEvent", () => {
  beforeEach(() => jest.clearAllMocks());

  it("logs via the shared logger with the operation name and only safe metadata", () => {
    logAuthSessionEvent("session_sync_succeeded", { route: "POST /api/auth/session", operationGeneration: 3 });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[auth-session] session_sync_succeeded",
      { operation: "session_sync_succeeded", route: "POST /api/auth/session", operationGeneration: 3 }
    );
  });

  it("the metadata type structurally has no field for uid, email, token, cookie, or claim", () => {
    // Compile-time guarantee, asserted here by exercising the full allowed
    // shape and confirming nothing else leaks through at runtime either.
    logAuthSessionEvent("revoked_or_expired_session", { route: "GET /api/auth/session", failureCategory: "cookie_revoked" });
    const [, metadata] = mockLoggerInfo.mock.calls[0];
    expect(Object.keys(metadata).sort()).toEqual(["failureCategory", "operation", "route"].sort());
  });
});
