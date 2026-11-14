/**
 * `readApiErrorMessage` reads both error shapes the governance dashboard
 * receives: a route's `{ error: { message } }` and the privileged-access
 * guard's `{ error: "<message>", reason }` (POST /api/governance/policy since
 * S2-b). Before the correction the guard's string `error` fell through to the
 * generic fallback.
 */

import { readApiErrorMessage } from "@/components/governance/governanceUtils";

const json = (body: unknown, status = 400) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readApiErrorMessage", () => {
  it("object error: returns error.message", async () => {
    await expect(readApiErrorMessage(json({ ok: false, error: { code: "validation_error", message: "Validation failed" } }), "fb")).resolves.toBe(
      "Validation failed"
    );
  });

  it("string error (the guard's denial body): returns the string, not the fallback", async () => {
    await expect(readApiErrorMessage(json({ error: "Forbidden", reason: "tier_not_held" }, 403), "Could not save policy.")).resolves.toBe("Forbidden");
    await expect(
      readApiErrorMessage(json({ error: "Authorization is temporarily unavailable", reason: "auth_unavailable" }, 503), "fb")
    ).resolves.toBe("Authorization is temporarily unavailable");
  });

  it("a blank string error falls through to message, then the fallback", async () => {
    await expect(readApiErrorMessage(json({ error: "  ", message: "top-level" }), "fb")).resolves.toBe("top-level");
    await expect(readApiErrorMessage(json({ error: "" }), "fb")).resolves.toBe("fb");
  });

  it("object error without a string message falls through to message", async () => {
    await expect(readApiErrorMessage(json({ error: { code: "x" }, message: "top-level" }), "fb")).resolves.toBe("top-level");
  });

  it("top-level message, non-JSON body and empty body", async () => {
    await expect(readApiErrorMessage(json({ message: "m" }), "fb")).resolves.toBe("m");
    await expect(readApiErrorMessage(json("<html>oops</html>", 500), "fb")).resolves.toBe("fb");
    await expect(readApiErrorMessage(json({}), "fb")).resolves.toBe("fb");
  });
});
