/**
 * Phase P0.2-VEMAIL-C1 — the authenticated diagnostic sink.
 *
 * This is deliberately NOT a general-purpose logging API. These tests pin that
 * down: closed enums, no free text, and a uid that comes from the verified
 * identity rather than the payload.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...(a as [])),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const info = jest.fn();
const warn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { info: (...a: unknown[]) => info(...(a as [])), warn: (...a: unknown[]) => warn(...(a as [])) } }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/user/email-verification-telemetry", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    })
  );

beforeEach(() => {
  info.mockReset();
  warn.mockReset();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: "real-uid", source: "bearer_token" });
});

describe("authentication", () => {
  it("unauthenticated request is denied and logs nothing", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await post({ event: "verification_email_send_accepted", source: "signup" });
    expect(res.status).toBe(401);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("uid provenance", () => {
  it("uid is derived from the verified identity", async () => {
    await post({ event: "verification_email_send_accepted", source: "signup" });
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uid: "real-uid" }));
  });

  it("THE FIX: a client-supplied uid cannot attribute an event to another user", async () => {
    await post({ event: "verification_email_send_accepted", source: "signup", uid: "victim-uid" });
    const [, meta] = info.mock.calls[0];
    expect(meta.uid).toBe("real-uid");
    expect(JSON.stringify(meta)).not.toContain("victim-uid");
  });
});

describe("closed schema", () => {
  it("accepts a valid accepted event", async () => {
    const res = await post({ event: "verification_email_send_accepted", source: "signup" });
    expect(res.status).toBe(200);
    expect(info).toHaveBeenCalled();
  });

  it("accepts a valid failed event with a safe code", async () => {
    const res = await post({ event: "verification_email_send_failed", source: "resend", errorCode: "auth/too-many-requests" });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ errorCode: "auth/too-many-requests" }));
  });

  it.each([
    ["unknown event", { event: "arbitrary_event", source: "signup" }],
    ["missing event", { source: "signup" }],
    ["event as object", { event: { a: 1 }, source: "signup" }],
  ])("rejects %s", async (_l, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown source", { event: "verification_email_send_accepted", source: "cron" }],
    ["missing source", { event: "verification_email_send_accepted" }],
  ])("rejects %s", async (_l, body) => {
    expect((await post(body)).status).toBe(400);
  });

  it("rejects a non-object body", async () => {
    expect((await post("[]")).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
  });

  it("THE FIX: there is no free-text field — arbitrary log content cannot be injected", async () => {
    await post({
      event: "verification_email_send_failed",
      source: "resend",
      message: "INJECTED ADMIN GRANTED",
      errorCode: "auth/network-request-failed",
    });
    const [msg, meta] = warn.mock.calls[0];
    expect(JSON.stringify({ msg, meta })).not.toContain("INJECTED");
  });

  it.each([
    ["over-long", "auth/" + "x".repeat(80)],
    ["wrong namespace", "firestore/denied"],
    ["an email address", "victim@example.com"],
    ["an action link", "https://x/__/auth/action?oobCode=SECRET"],
    ["a number", 42],
  ])("drops an unsafe errorCode (%s) rather than logging it", async (_l, code) => {
    await post({ event: "verification_email_send_failed", source: "resend", errorCode: code });
    const [, meta] = warn.mock.calls[0];
    expect(meta.errorCode).toBe("unknown");
    expect(JSON.stringify(meta)).not.toMatch(/victim@|oobCode|SECRET|xxxxx/);
  });
});

describe("it grants nothing and changes nothing", () => {
  it("the response carries no authority or user data", async () => {
    const res = await post({ event: "verification_email_send_accepted", source: "signup" });
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("log wording says the SDK CALL resolved/failed, never that mail was delivered", async () => {
    await post({ event: "verification_email_send_accepted", source: "signup" });
    const [msg] = info.mock.calls[0];
    expect(msg).toMatch(/NOT proof of delivery/i);
    expect(msg).not.toMatch(/\bdelivered\b(?!\))|\breceived\b/i);
    warn.mockReset();
    await post({ event: "verification_email_send_failed", source: "signup" });
    expect(warn.mock.calls[0][0]).toMatch(/not a delivery result/i);
  });
});
