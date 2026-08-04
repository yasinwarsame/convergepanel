const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";

describe("logIdentityResolutionFailure", () => {
  beforeEach(() => jest.clearAllMocks());

  it("logs via the shared logger with only safe metadata", () => {
    logIdentityResolutionFailure({ route: "GET /api/user/usage", method: "GET", failureCategory: "credential_mismatch" });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[auth-identity] resolution_failed",
      { operation: "identity_resolution_failed", route: "GET /api/user/usage", method: "GET", failureCategory: "credential_mismatch" }
    );
  });

  it("metadata carries no uid/email/token/cookie/claim field", () => {
    logIdentityResolutionFailure({ route: "POST /api/verify-claim", failureCategory: "invalid_bearer_token" });
    const [, metadata] = mockLoggerWarn.mock.calls[0];
    expect(Object.keys(metadata).sort()).toEqual(["failureCategory", "operation", "route"].sort());
  });
});
