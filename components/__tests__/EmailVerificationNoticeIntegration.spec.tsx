/**
 * Phase P0.2-VEMAIL-C3 — component + REAL bounded helper.
 *
 * The review found the component suite mocks `@/lib/client/emailVerificationSend`
 * wholesale, so nothing exercised the component together with the real bounded
 * telemetry helper — which is precisely why the fetch-only timeout defect passed
 * the suite: the "telemetry never resolves" test manually released the promise
 * before asserting, proving "released after telemetry settles" rather than
 * "bounded".
 *
 * Here the send helper is REAL. Only the lowest-level dependencies are doubled:
 * `firebase/auth` and `authedFetch` (which is where token acquisition and the
 * network call live). Stalls are injected at each layer that previously could
 * hang the control.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

let currentUser: { emailVerified: boolean; uid: string } | null = { emailVerified: false, uid: "uid-A" };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: currentUser }) }));

const sendEmailVerification = jest.fn();
const reload = jest.fn();
jest.mock("firebase/auth", () => ({
  sendEmailVerification: (...a: unknown[]) => sendEmailVerification(...(a as [])),
  reload: (...a: unknown[]) => reload(...(a as [])),
}));

const authedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...a: unknown[]) => authedFetch(...(a as [])),
}));

// REAL helper module — not mocked.
import { MAX_RESEND_PENDING_MS } from "@/lib/client/emailVerificationSend";
import EmailVerificationNotice from "../EmailVerificationNotice";

const installStorage = () => {
  const data: Record<string, string> = {};
  Object.defineProperty(globalThis, "sessionStorage", {
    value: {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => { data[k] = v; },
      removeItem: (k: string) => { delete data[k]; },
    },
    configurable: true, writable: true,
  });
};

const mounted: TestRenderer.ReactTestRenderer[] = [];
const renderAsync = async () => {
  let r: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(createElement(EmailVerificationNotice)); });
  mounted.push(r!);
  return r!;
};
const button = (r: TestRenderer.ReactTestRenderer) => r.root.findByType("button");

beforeEach(() => {
  jest.useRealTimers();
  currentUser = { emailVerified: false, uid: "uid-A" };
  reload.mockReset().mockResolvedValue(undefined);
  sendEmailVerification.mockReset().mockResolvedValue(undefined);
  authedFetch.mockReset().mockResolvedValue(undefined);
  installStorage();
});
afterEach(() => {
  act(() => { mounted.forEach((r) => r.unmount()); });
  mounted.length = 0;
  jest.useRealTimers();
});

/** Drain microtasks while fake timers are installed. */
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("real bounded helper — no layer can lock the resend control", () => {
  it("THE FIX: a stall BEFORE the fetch (token acquisition) still releases the control", async () => {
    const r = await renderAsync();
    // authedFetch never settles at all — this models getIdToken() hanging,
    // which an AbortSignal on fetch cannot cancel.
    authedFetch.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    let click: Promise<unknown>;
    await act(async () => { click = button(r).props.onClick(); await flush(); });
    await act(async () => { jest.advanceTimersByTime(MAX_RESEND_PENDING_MS + 100); await flush(); });
    await act(async () => { await click!; });
    expect(button(r).props.children).not.toMatch(/Sending/);
    // The Firebase send itself did happen; only the diagnostic was abandoned.
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("THE FIX: a stalled telemetry FETCH is aborted and the control releases", async () => {
    const r = await renderAsync();
    authedFetch.mockImplementation((_u: string, o: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => { o.signal?.addEventListener("abort", () => rej(new Error("aborted"))); })
    );
    jest.useFakeTimers();
    let click: Promise<unknown>;
    await act(async () => { click = button(r).props.onClick(); await flush(); });
    await act(async () => { jest.advanceTimersByTime(MAX_RESEND_PENDING_MS + 100); await flush(); });
    await act(async () => { await click!; });
    expect(button(r).props.children).not.toMatch(/Sending/);
  });

  it("THE FIX: a hanging verification reload releases the control without sending", async () => {
    const r = await renderAsync();
    reload.mockImplementation(() => new Promise(() => {}));
    sendEmailVerification.mockClear();
    jest.useFakeTimers();
    let click: Promise<unknown>;
    await act(async () => { click = button(r).props.onClick(); await flush(); });
    await act(async () => { jest.advanceTimersByTime(MAX_RESEND_PENDING_MS + 100); await flush(); });
    await act(async () => { await click!; });
    expect(button(r).props.children).not.toMatch(/Sending/);
    // No mail sent when we could not confirm the user is still unverified.
    expect(sendEmailVerification).not.toHaveBeenCalled();
    expect(authedFetch).not.toHaveBeenCalled();   // and no send diagnostic emitted
  });

  it("THE FIX: a stalled Firebase SEND releases the control and is not called a failure", async () => {
    const r = await renderAsync();
    sendEmailVerification.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    let click: Promise<unknown>;
    await act(async () => { click = button(r).props.onClick(); await flush(); });
    await act(async () => { jest.advanceTimersByTime(MAX_RESEND_PENDING_MS + 100); await flush(); });
    await act(async () => { await click!; });
    const t = JSON.stringify(r.toJSON());
    expect(button(r).props.children).not.toMatch(/Sending/);
    expect(t).toMatch(/couldn't confirm that the verification email was sent/i);
    expect(t).not.toMatch(/couldn't send the verification email/i);
    // Operator sees a distinct event, never accepted and never failed.
    const body = JSON.parse((authedFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.event).toBe("verification_email_send_timed_out");
  });

  it("LATE COMPLETION: the Firebase send finishing after timeout does not flip the UI to success", async () => {
    let release: (v?: unknown) => void = () => {};
    const r = await renderAsync();
    sendEmailVerification.mockImplementation(() => new Promise((res) => { release = res; }));
    jest.useFakeTimers();
    let click: Promise<unknown>;
    await act(async () => { click = button(r).props.onClick(); await flush(); });
    await act(async () => { jest.advanceTimersByTime(MAX_RESEND_PENDING_MS + 100); await flush(); });
    await act(async () => { await click!; });
    const before = JSON.stringify(r.toJSON());
    await act(async () => { release(); await flush(); });
    expect(JSON.stringify(r.toJSON())).toBe(before);
    expect(JSON.stringify(r.toJSON())).not.toMatch(/Verification email requested/i);
    // and no late accepted diagnostic
    const events = authedFetch.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body).event);
    expect(events).not.toContain("verification_email_send_accepted");
  });

  it("the happy path still works end to end through the real helper", async () => {
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
    expect(authedFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((authedFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.event).toBe("verification_email_send_accepted");
    expect(body.source).toBe("resend");
  });

  it("a real Firebase send failure reaches the diagnostic as FAILED, through the real helper", async () => {
    sendEmailVerification.mockRejectedValue({ code: "auth/too-many-requests" });
    const r = await renderAsync();
    await act(async () => { await button(r).props.onClick(); });
    const body = JSON.parse((authedFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.event).toBe("verification_email_send_failed");
    expect(body.errorCode).toBe("auth/too-many-requests");
  });
});
