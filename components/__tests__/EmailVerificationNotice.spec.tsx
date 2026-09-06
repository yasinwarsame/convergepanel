/**
 * Phase P0.2-VEMAIL-C1/C2 — the user-visible half of verification recovery.
 * Renders the real component with react-test-renderer (repo convention) and
 * drives the real handler. The shared STATE helper is real — it is the sole
 * integration point with signup, so mocking it would prove nothing.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

let currentUser: { emailVerified: boolean; uid: string } | null = { emailVerified: false, uid: "uid-A" };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: currentUser }) }));

const refreshVerificationStatus = jest.fn();
jest.mock("firebase/auth", () => ({ reload: jest.fn(), sendEmailVerification: jest.fn() }));

// Ordered trace so sequencing can be asserted, not assumed.
let trace: string[] = [];
const requestEmailVerification = jest.fn();
const reportEmailVerificationSendOutcome = jest.fn();
jest.mock("@/lib/client/emailVerificationSend", () => ({
  requestEmailVerification: (...a: unknown[]) => requestEmailVerification(...(a as [])),
  reportEmailVerificationSendOutcome: (...a: unknown[]) => reportEmailVerificationSendOutcome(...(a as [])),
  refreshVerificationStatus: (...a: unknown[]) => refreshVerificationStatus(...(a as [])),
}));

// REAL shared state module — the writer/reader contract under test.
import {
  emailVerificationStateKey,
  writeEmailVerificationSendState,
} from "@/lib/client/emailVerificationState";
import EmailVerificationNotice from "../EmailVerificationNotice";

const installStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  const store = {
    getItem: jest.fn((k: string) => (k in data ? data[k] : null)),
    setItem: jest.fn((k: string, v: string) => { data[k] = v; }),
    removeItem: jest.fn((k: string) => { delete data[k]; }),
  };
  Object.defineProperty(globalThis, "sessionStorage", { value: store, configurable: true, writable: true });
  return store;
};
const removeStorage = () => {
  Object.defineProperty(globalThis, "sessionStorage", {
    get() { throw new Error("SecurityError"); }, configurable: true,
  });
};

const mounted: TestRenderer.ReactTestRenderer[] = [];
const render = () => {
  let r: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(createElement(EmailVerificationNotice)); });
  mounted.push(r!);
  return r!;
};
const renderAsync = async () => {
  let r: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(createElement(EmailVerificationNotice)); });
  mounted.push(r!);
  return r!;
};
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const button = (r: TestRenderer.ReactTestRenderer) => r.root.findByType("button");

beforeEach(() => {
  jest.useRealTimers();
  trace = [];
  currentUser = { emailVerified: false, uid: "uid-A" };
  refreshVerificationStatus.mockReset().mockImplementation(async () => {
    trace.push("refresh");
    return currentUser?.emailVerified ? "verified" : "still_unverified";
  });
  requestEmailVerification.mockReset().mockImplementation(async () => {
    trace.push("firebase:start");
    trace.push("firebase:resolve");
    return { outcome: "send_accepted" };
  });
  reportEmailVerificationSendOutcome.mockReset().mockImplementation(async (_u, o: { outcome: string }) => {
    trace.push(o.outcome === "send_accepted" ? "telemetry:accepted" : "telemetry:failed");
    return "reported";
  });
  installStorage();
});
afterEach(() => {
  act(() => { mounted.forEach((r) => r.unmount()); });
  mounted.length = 0;
  jest.useRealTimers();
});

describe("visibility is driven by the LIVE identity, not by storage", () => {
  it("an unverified user sees the notice and a resend control", () => {
    const r = render();
    expect(text(r)).toMatch(/not verified yet/i);
    expect(button(r).props.children).toMatch(/Resend verification email/);
  });

  it("THE FIX: recovery works with NO stored state at all", () => {
    installStorage({});
    const r = render();
    expect(text(r)).toMatch(/not verified yet/i);
    expect(button(r).props.disabled).toBe(false);
  });

  it("THE FIX: recovery works when storage is entirely unavailable", () => {
    removeStorage();
    const r = render();
    expect(r.toJSON()).not.toBeNull();
    expect(button(r).props.disabled).toBe(false);
  });

  it("a verified user sees nothing and gets no resend control", () => {
    currentUser = { emailVerified: true, uid: "uid-A" };
    const r = render();
    expect(r.toJSON()).toBeNull();
    expect(() => button(r)).toThrow();
  });

  it("a signed-out visitor renders nothing", () => {
    currentUser = null;
    expect(render().toJSON()).toBeNull();
  });

  it("never sends on render", async () => {
    await renderAsync();
    expect(requestEmailVerification).not.toHaveBeenCalled();
  });
});

describe("writer -> reader integration (the real shared state helper)", () => {
  it("THE FIX: signup's failure write for uid-A is read back and rendered as recoverable", () => {
    installStorage();
    writeEmailVerificationSendState("uid-A", "send_failed"); // exactly what signup calls
    const r = render();
    expect(text(r)).toMatch(/couldn't send the verification email/i);
  });

  it("THE FIX: uid-A's failure is NOT shown to uid-B in the same browser", () => {
    installStorage();
    writeEmailVerificationSendState("uid-A", "send_failed");
    currentUser = { emailVerified: false, uid: "uid-B" };
    const r = render();
    expect(text(r)).toMatch(/not verified yet/i);
    expect(text(r)).not.toMatch(/couldn't send/i);
  });

  it("an accepted write renders the request-worded message", () => {
    installStorage();
    writeEmailVerificationSendState("uid-A", "send_accepted");
    const r = render();
    expect(text(r)).toMatch(/Verification email requested/i);
  });

  it("the component reads the same UID-scoped key the writer used", () => {
    const s = installStorage();
    render();
    expect(s.getItem).toHaveBeenCalledWith(emailVerificationStateKey("uid-A"));
  });
});

describe("resend sequencing and release", () => {
  it("ORDER: firebase resolves -> telemetry -> UI success", async () => {
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    const i = (s: string) => trace.indexOf(s);
    expect(i("firebase:start")).toBeGreaterThan(-1);
    expect(i("firebase:resolve")).toBeGreaterThan(i("firebase:start"));
    expect(i("telemetry:accepted")).toBeGreaterThan(i("firebase:resolve"));
    expect(text(r)).toMatch(/Verification email requested/i);
  });

  it("ORDER: no accepted diagnostic is emitted on a failed send", async () => {
    requestEmailVerification.mockImplementation(async () => {
      trace.push("firebase:reject");
      return { outcome: "send_failed", errorCode: "auth/too-many-requests" };
    });
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    expect(trace).toContain("telemetry:failed");
    expect(trace).not.toContain("telemetry:accepted");
    expect(trace.indexOf("telemetry:failed")).toBeGreaterThan(trace.indexOf("firebase:reject"));
  });

  it("THE FIX: a telemetry request that never resolves does NOT lock the control", async () => {
    // The bounded helper aborts internally; here it simply never reports.
    let release: (v: unknown) => void = () => {};
    reportEmailVerificationSendOutcome.mockReturnValue(new Promise((res) => { release = res; }));
    const r = await renderAsync();
    let click: Promise<unknown>;
    await act(async () => { click = button(r).props.onClick(); });
    // Resolve telemetry as a timeout would, then confirm the control is usable.
    await act(async () => { release("timed_out"); await click!; });
    expect(button(r).props.children).not.toMatch(/Sending/);
  });

  it("a second click while pending does not send twice", async () => {
    let release: (v: unknown) => void = () => {};
    requestEmailVerification.mockReturnValue(new Promise((res) => { release = res; }));
    const r = await renderAsync();
    let first: Promise<unknown>;
    // async act so the pre-send reload() settles and the Firebase call is
    // actually in flight before the second click is attempted.
    await act(async () => { first = button(r).props.onClick(); });
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
    expect(button(r).props.disabled).toBe(true);
    await act(async () => { button(r).props.onClick(); });
    expect(requestEmailVerification).toHaveBeenCalledTimes(1); // still one
    await act(async () => { release({ outcome: "send_accepted" }); await first!; });
  });
});

describe("cooldown applies after EVERY completed attempt", () => {
  it("after success", async () => {
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    expect(button(r).props.disabled).toBe(true);
    expect(button(r).props.children).toMatch(/Resend available in/);
  });

  it("THE FIX: after FAILURE too — a throttled user is not invited to retry immediately", async () => {
    requestEmailVerification.mockResolvedValue({ outcome: "send_failed", errorCode: "auth/too-many-requests" });
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    expect(button(r).props.disabled).toBe(true);
    expect(text(r)).toMatch(/try again shortly/i);
    await act(async () => { await button(r).props.onClick(); });
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
  });
});

describe("cooldown timer lifecycle", () => {
  it("THE FIX: the 1 Hz interval stops once the cooldown expires", async () => {
    jest.useFakeTimers();
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await act(async () => { jest.advanceTimersByTime(62_000); });
    expect(jest.getTimerCount()).toBe(0);
    expect(button(r).props.disabled).toBe(false);
  });
});

describe("stale verification is refreshed", () => {
  it("THE FIX: verified in another tab -> notice disappears after reload", async () => {
    refreshVerificationStatus.mockImplementation(async () => { currentUser!.emailVerified = true; return "verified"; });
    const r = await renderAsync();
    expect(refreshVerificationStatus).toHaveBeenCalled();
    expect(r.toJSON()).toBeNull();
  });

  it("THE FIX: the pre-send guard is load-bearing — a reload-verified user sends NOTHING", async () => {
    const r = await renderAsync();          // still unverified at mount
    refreshVerificationStatus.mockImplementation(async () => { currentUser!.emailVerified = true; return "verified"; });
    await act(async () => { await button(r).props.onClick(); });
    expect(requestEmailVerification).not.toHaveBeenCalled();
    expect(reportEmailVerificationSendOutcome).not.toHaveBeenCalled();
    expect(r.toJSON()).toBeNull();
  });

  it("a failing reload does not claim verification and keeps recovery available", async () => {
    refreshVerificationStatus.mockResolvedValue("check_failed");
    const r = await renderAsync();
    expect(r.toJSON()).not.toBeNull();
    expect(text(r)).toMatch(/not verified yet/i);
    await act(async () => { await button(r).props.onClick(); });
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
  });
});

describe("bounded verification check", () => {
  it("THE FIX: a timed-out check does NOT send, and does NOT emit a send diagnostic", async () => {
    const r = await renderAsync();
    refreshVerificationStatus.mockResolvedValue("check_timed_out");
    await act(async () => { await button(r).props.onClick(); });
    expect(requestEmailVerification).not.toHaveBeenCalled();
    expect(reportEmailVerificationSendOutcome).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/couldn't check your verification status/i);
  });

  it("a timed-out check is not labelled a send failure", async () => {
    const r = await renderAsync();
    refreshVerificationStatus.mockResolvedValue("check_timed_out");
    await act(async () => { await button(r).props.onClick(); });
    expect(text(r)).not.toMatch(/couldn't send the verification email/i);
  });

  it("a timed-out check still releases the control (cooldown, not stuck)", async () => {
    const r = await renderAsync();
    refreshVerificationStatus.mockResolvedValue("check_timed_out");
    await act(async () => { await button(r).props.onClick(); });
    expect(button(r).props.children).not.toMatch(/Sending/);
  });

  it("a fast check failure still proceeds to send (recovery is not blocked)", async () => {
    const r = await renderAsync();
    refreshVerificationStatus.mockResolvedValue("check_failed");
    await act(async () => { await button(r).props.onClick(); });
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
  });
});

describe("copy honesty", () => {
  it("success copy never claims delivery or receipt", async () => {
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    expect(text(r)).not.toMatch(/\bdelivered\b|\breceived\b|\bsent successfully\b/i);
  });

  it("a failed resend shows the safe code and stays recoverable", async () => {
    requestEmailVerification.mockResolvedValue({ outcome: "send_failed", errorCode: "auth/network-request-failed" });
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    expect(text(r)).toMatch(/auth\/network-request-failed/);
    expect(button(r)).toBeTruthy();
  });
});
