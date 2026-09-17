/**
 * TEAM-VERIFICATION-PARITY-R2 — Personal characterization of
 * `ClaimVerificationResult` and `VideoVerificationResult` (the Personal
 * wrappers). Written against the pre-R2 components and kept unchanged across
 * the extraction: live governance fetch lifecycle, cached governance, Personal
 * actions (copy, memo export, audit trail + JSON), Verify Another, and the
 * rendered result content.
 */

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
let auth: { user: { uid: string; email: string } | null; authReady: boolean } = { user: { uid: "uid-owner", email: "owner@example.com" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "pro", governanceAssignedReviewerEmail: null }) }));
const mockedGenerateMemo = jest.fn(() => "MEMO");
const mockedDownloadTextFile = jest.fn();
jest.mock("@/lib/verification/generateMemo", () => ({
  generateVerificationMemo: (...a: unknown[]) => (mockedGenerateMemo as unknown as (...x: unknown[]) => string)(...a),
  downloadTextFile: (...a: unknown[]) => mockedDownloadTextFile(...a),
}));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ClaimVerificationResult from "@/components/ClaimVerificationResult";
import VideoVerificationResult from "@/components/VideoVerificationResult";
import { GovernanceBadge } from "@/components/GovernanceBadge";
import { claimFixture, videoFixture } from "@/components/verification/__tests__/verificationResultFixtures";

type Kind = "claim" | "video";
const CASES: Array<{ kind: Kind; collection: string; component: unknown; fixture: (o?: Record<string, unknown>) => Record<string, unknown>; verifyAnother: string; banner: string; subject: string }> = [
  { kind: "claim", collection: "verifications", component: ClaimVerificationResult, fixture: (o) => claimFixture(o as never) as never, verifyAnother: "Verify another claim", banner: "This claim is supported by 1/2 models", subject: "The Eiffel Tower was completed in 1889." },
  { kind: "video", collection: "videoVerifications", component: VideoVerificationResult, fixture: (o) => videoFixture(o as never) as never, verifyAnother: "Verify another video", banner: "Authentic camera footage", subject: "harbour-clip.mp4" },
];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const ok = (body: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) });
async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(component: unknown, props: Record<string, unknown>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(component as never, props as never));
  });
  await flush();
  return r;
}
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}
const button = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAll((n) => n.type === "button" && nodeText(n).includes(label))[0];
const badge = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(GovernanceBadge).props;

let clipboardWrites: string[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  auth = { user: { uid: "uid-owner", email: "owner@example.com" }, authReady: true };
  clipboardWrites = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (t: string) => void clipboardWrites.push(t) } } });
  jest.spyOn(globalThis, "fetch" as never).mockImplementation((() => {
    throw new Error("raw fetch is never used by verification results");
  }) as never);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe.each(CASES)("Personal $kind result", ({ collection, component, fixture, verifyAnother, banner, subject }) => {
  it("mount -> exactly one live governance read for this verification, via authedFetch", async () => {
    mockedAuthedFetch.mockResolvedValue(ok({ governanceStatus: "needs_review" }));
    const data = fixture();
    await mount(component, { data, onVerifyAnother: jest.fn() });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedAuthedFetch.mock.calls[0];
    expect(url).toBe(`/api/user/run-governance?runId=${data.verificationId}&collection=${collection}`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", authReady: true, user: auth.user });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("cached governance shows first; a successful live read replaces it with reviewer details", async () => {
    const d = deferred<ReturnType<typeof ok>>();
    mockedAuthedFetch.mockReturnValue(d.promise);
    const r = await mount(component, { data: fixture({ governanceStatus: "needs_review" }), onVerifyAnother: jest.fn() });
    expect(badge(r)).toMatchObject({ status: "needs_review", reviewedBy: undefined, viewerEmail: "owner@example.com" });
    await act(async () => {
      d.resolve(ok({ governanceStatus: "approved", governanceReviewedBy: "rev-1", governanceReviewerEmail: "rev@example.com", governanceReviewedAt: "2026-09-11T00:00:00.000Z", governanceReviewComment: "Looks right" }));
    });
    await flush();
    expect(badge(r)).toMatchObject({ status: "approved", reviewedBy: "rev-1", reviewerEmail: "rev@example.com", reviewedAt: "2026-09-11T00:00:00.000Z", reviewComment: "Looks right" });
  });

  it("a failed or concealed governance read keeps the cached status", async () => {
    mockedAuthedFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ ok: false, errorCode: "not_found" }) });
    const r = await mount(component, { data: fixture({ governanceStatus: "blocked" }), onVerifyAnother: jest.fn() });
    expect(badge(r).status).toBe("blocked");
    mockedAuthedFetch.mockRejectedValueOnce(new Error("network"));
    const r2 = await mount(component, { data: fixture({ verificationId: "other-id", governanceStatus: "needs_review" }), onVerifyAnother: jest.fn() });
    expect(badge(r2).status).toBe("needs_review");
  });

  it("a late response for a previous verification never overwrites the current one; a late response after unmount is ignored", async () => {
    const first = deferred<ReturnType<typeof ok>>();
    mockedAuthedFetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok({ governanceStatus: "approved" }));
    const onVerifyAnother = jest.fn();
    const r = await mount(component, { data: fixture({ verificationId: "first-id" }), onVerifyAnother });
    await act(async () => {
      r.update(createElement(component as never, { data: fixture({ verificationId: "second-id" }), onVerifyAnother } as never));
    });
    await flush();
    expect(badge(r).status).toBe("approved");
    await act(async () => {
      first.resolve(ok({ governanceStatus: "blocked" }));
    });
    await flush();
    expect(badge(r).status).toBe("approved");

    const late = deferred<ReturnType<typeof ok>>();
    mockedAuthedFetch.mockReturnValueOnce(late.promise);
    const r3 = await mount(component, { data: fixture({ verificationId: "third-id" }), onVerifyAnother });
    await act(async () => r3.unmount());
    await act(async () => {
      late.resolve(ok({ governanceStatus: "blocked" }));
    });
    await flush();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("no signed-in user, or auth not ready, or no verificationId -> no governance read", async () => {
    auth = { user: null, authReady: true };
    await mount(component, { data: fixture(), onVerifyAnother: jest.fn() });
    auth = { user: { uid: "u", email: "u@example.com" }, authReady: false };
    await mount(component, { data: fixture(), onVerifyAnother: jest.fn() });
    auth = { user: { uid: "u", email: "u@example.com" }, authReady: true };
    await mount(component, { data: fixture({ verificationId: "  " }), onVerifyAnother: jest.fn() });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });

  it("renders the stored result content", async () => {
    mockedAuthedFetch.mockResolvedValue(ok({}));
    const r = await mount(component, { data: fixture(), onVerifyAnother: jest.fn() });
    const t = text(r);
    expect(t).toContain(banner);
    expect(t).toContain(subject);
    expect(t).toContain("Consensus score");
    expect(t).toContain("Per-model evidence");
    expect(t).toContain("Agreement &amp; disagreement".replace("&amp;", "&"));
    expect(r.root.findAll((n) => n.type === "a").map((n) => n.props.href)).toEqual(["/terms", "/terms"]);
  });

  it("Personal actions: copy, export memo, audit trail with JSON copy/download, and Verify Another", async () => {
    mockedAuthedFetch.mockResolvedValue(ok({}));
    const onVerifyAnother = jest.fn();
    const r = await mount(component, { data: fixture(), onVerifyAnother });
    expect(button(r, "Copy verdict")).toBeDefined();
    expect(button(r, "Export memo")).toBeDefined();
    expect(button(r, "View audit trail")).toBeDefined();

    await act(async () => button(r, "Copy verdict").props.onClick());
    await flush();
    expect(clipboardWrites).toHaveLength(1);
    expect(clipboardWrites[0]).toContain(subject.includes(".mp4") ? "VIDEO VERIFICATION RESULT" : "ConvergePanel — Claim result");

    await act(async () => button(r, "Export memo").props.onClick());
    expect(mockedGenerateMemo).toHaveBeenCalledTimes(1);
    expect(mockedDownloadTextFile).toHaveBeenCalledTimes(1);

    expect(text(r)).not.toContain("Copy as JSON");
    await act(async () => button(r, "View audit trail").props.onClick());
    expect(text(r)).toContain("Audit trail");
    expect(text(r)).toContain("Copy as JSON");
    expect(text(r)).toContain("Download .json");
    expect(button(r, "Hide audit trail")).toBeDefined();

    await act(async () => button(r, verifyAnother).props.onClick());
    expect(onVerifyAnother).toHaveBeenCalledTimes(1);
    // Unmount clears VerificationActions' "Copied!" reset timer.
    await act(async () => r.unmount());
  });
});

describe("Personal Claim-only ancillary: create-response team policy notice", () => {
  it("renders the legacy policy notice only when the create response flagged it", async () => {
    mockedAuthedFetch.mockResolvedValue(ok({}));
    const plain = await mount(ClaimVerificationResult, { data: claimFixture(), onVerifyAnother: jest.fn() });
    expect(text(plain)).not.toContain("Team governance review");
    const flagged = await mount(ClaimVerificationResult, { data: claimFixture({ governanceReviewRequired: true, policyFlags: ["sensitive_topic"] }), onVerifyAnother: jest.fn() });
    expect(text(flagged)).toContain("Team governance review");
    expect(text(flagged)).toContain("sensitive_topic");
    const blocked = await mount(ClaimVerificationResult, { data: claimFixture({ blockedByPolicy: true, policyBlockMessage: "Blocked message" }), onVerifyAnother: jest.fn() });
    expect(text(blocked)).toContain("Blocked by team policy");
    expect(text(blocked)).toContain("Blocked message");
  });
});
