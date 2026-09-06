/**
 * Phase P0.2-VEMAIL-C1 — the user-visible half of verification recovery.
 * Renders the real component with react-test-renderer (repo convention) and
 * drives the real button handler; only the auth context and the send helper
 * are doubled.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

let currentUser: { emailVerified: boolean } | null = { emailVerified: false };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: currentUser }) }));

const requestEmailVerification = jest.fn();
const reportEmailVerificationSendOutcome = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/client/emailVerificationSend", () => ({
  requestEmailVerification: (...a: unknown[]) => requestEmailVerification(...(a as [])),
  reportEmailVerificationSendOutcome: (...a: unknown[]) => reportEmailVerificationSendOutcome(...(a as [])),
}));

import EmailVerificationNotice from "../EmailVerificationNotice";

// Every renderer is unmounted in afterEach: the cooldown timer is a live
// setInterval, and leaving one mounted keeps the Jest worker alive forever.
const mounted: TestRenderer.ReactTestRenderer[] = [];
const render = () => {
  let r: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(createElement(EmailVerificationNotice)); });
  mounted.push(r!);
  return r!;
};
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const button = (r: TestRenderer.ReactTestRenderer) => r.root.findByType("button");

beforeEach(() => {
  currentUser = { emailVerified: false };
  requestEmailVerification.mockReset().mockResolvedValue({ outcome: "send_accepted" });
  reportEmailVerificationSendOutcome.mockReset().mockResolvedValue(undefined);
  try { sessionStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  act(() => { mounted.forEach((r) => r.unmount()); });
  mounted.length = 0;
});

describe("visibility", () => {
  it("an unverified user sees the notice and a resend control", () => {
    const r = render();
    expect(text(r)).toMatch(/not verified yet/i);
    expect(button(r).props.children).toMatch(/Resend verification email/);
  });

  it("THE FIX: a VERIFIED user sees nothing and gets no resend control", () => {
    currentUser = { emailVerified: true };
    const r = render();
    expect(r.toJSON()).toBeNull();
    expect(() => button(r)).toThrow();
  });

  it("a signed-out visitor renders nothing", () => {
    currentUser = null;
    expect(render().toJSON()).toBeNull();
  });

  it("never sends on render — mounting mails nobody", () => {
    render();
    expect(requestEmailVerification).not.toHaveBeenCalled();
  });
});

describe("resend", () => {
  it("invokes the REAL helper path and reports the outcome as source=resend", async () => {
    const r = render();
    await act(async () => { await button(r).props.onClick(); });
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
    expect(reportEmailVerificationSendOutcome).toHaveBeenCalledWith(
      expect.anything(), { outcome: "send_accepted" }, "resend"
    );
  });

  it("a successful resend is shown, worded as a request — never as delivery", async () => {
    const r = render();
    await act(async () => { await button(r).props.onClick(); });
    const t = text(r);
    expect(t).toMatch(/Verification email requested/i);
    expect(t).not.toMatch(/\bdelivered\b|\breceived\b|\bsent successfully\b/i);
  });

  it("THE FIX: a failed resend is shown, with the safe code, and is not destructive", async () => {
    requestEmailVerification.mockResolvedValue({ outcome: "send_failed", errorCode: "auth/too-many-requests" });
    const r = render();
    await act(async () => { await button(r).props.onClick(); });
    const t = text(r);
    expect(t).toMatch(/couldn't send the verification email/i);
    expect(t).toMatch(/auth\/too-many-requests/);
    expect(button(r)).toBeTruthy(); // still recoverable
  });

  it("a second click while a request is in flight does not send twice", async () => {
    let release: (v: unknown) => void = () => {};
    requestEmailVerification.mockReturnValue(new Promise((res) => { release = res; }));
    const r = render();
    let first: Promise<unknown>;
    act(() => { first = button(r).props.onClick(); });
    act(() => { button(r).props.onClick(); });   // second click, still pending
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
    expect(button(r).props.disabled).toBe(true);
    await act(async () => { release({ outcome: "send_accepted" }); await first!; });
  });

  it("cooldown blocks an immediate third send after success", async () => {
    const r = render();
    await act(async () => { await button(r).props.onClick(); });
    expect(button(r).props.disabled).toBe(true);
    expect(button(r).props.children).toMatch(/Resend available in/);
    await act(async () => { await button(r).props.onClick(); });
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("the control DISAPPEARS once the identity becomes verified, so no further send is possible", async () => {
    const r = render();
    expect(button(r)).toBeTruthy();
    // Verification lands; the auth context now reports a verified user and the
    // component re-renders. The whole notice — control included — goes away.
    currentUser = { emailVerified: true };
    act(() => { r.update(createElement(EmailVerificationNotice)); });
    expect(r.toJSON()).toBeNull();
    expect(() => button(r)).toThrow();
    expect(requestEmailVerification).not.toHaveBeenCalled();
  });
});

describe("initial-send failure carried from signup", () => {
  it("shows the recoverable failure message when signup recorded a failed send", () => {
    try { sessionStorage.setItem("cp_verification_send_failed", "1"); } catch { /* ignore */ }
    const r = render();
    expect(text(r)).toMatch(/couldn't send the verification email/i);
  });
});
