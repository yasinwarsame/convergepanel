/**
 * Private advisory GHSA-655j-5f43-92pw — the per-document telemetry decision.
 * Each test loads a fresh module (one decision per document).
 */
type Win = Parameters<typeof import("../telemetryFreeDocument").isTelemetryFreeDocument>[0];

function fresh(): typeof import("../telemetryFreeDocument") {
  let mod: typeof import("../telemetryFreeDocument");
  jest.isolateModules(() => {
    mod = require("../telemetryFreeDocument");
  });
  return mod!;
}

const ACCEPT_URL = "https://convergepanel.com/workspace-invitations/accept#invitationId=i&token=t";
const nav = (name: string | null) => ({ getEntriesByType: (t: string) => (t === "navigation" && name !== null ? [{ name }] : []) });

describe("isTelemetryFreeDocument", () => {
  it("decides from the navigation entry, not the current address bar (already scrubbed or navigated away)", () => {
    const { isTelemetryFreeDocument } = fresh();
    const win: Win = { location: { pathname: "/workspace/team/ws-1" }, performance: nav(ACCEPT_URL) };
    expect(isTelemetryFreeDocument(win)).toBe(true);
  });

  it("a document loaded elsewhere is not telemetry-free even if it is currently on the acceptance path", () => {
    const { isTelemetryFreeDocument } = fresh();
    const win: Win = { location: { pathname: "/workspace-invitations/accept" }, performance: nav("https://convergepanel.com/workspace") };
    expect(isTelemetryFreeDocument(win)).toBe(false);
  });

  it("is decided once per document: a later pathname change cannot flip it (no navigation entry available)", () => {
    const { isTelemetryFreeDocument } = fresh();
    const loc = { pathname: "/workspace-invitations/accept" };
    const win: Win = { location: loc, performance: nav(null) };
    expect(isTelemetryFreeDocument(win)).toBe(true);
    loc.pathname = "/pricing";
    expect(isTelemetryFreeDocument(win)).toBe(true);

    const second = fresh();
    const loc2 = { pathname: "/pricing" };
    const win2: Win = { location: loc2, performance: nav(null) };
    expect(second.isTelemetryFreeDocument(win2)).toBe(false);
    loc2.pathname = "/workspace-invitations/accept";
    expect(second.isTelemetryFreeDocument(win2)).toBe(false);
  });

  it("fails closed when neither the navigation entry nor the location can be read", () => {
    const { isTelemetryFreeDocument } = fresh();
    const win = {
      get location(): { pathname: string } {
        throw new Error("blocked");
      },
      performance: {
        getEntriesByType: () => {
          throw new Error("blocked");
        },
      },
    } as unknown as Win;
    expect(isTelemetryFreeDocument(win)).toBe(true);
  });

  it("correction round: a document whose tab holds the invitation envelope is telemetry-free whatever its URL; any value under the key counts; blocked storage reads as absent", () => {
    const KEY = "convergepanel.invitationAcceptance.v1";
    const store = (v: string | null) => ({ getItem: (k: string) => (k === KEY ? v : null) });
    const login = nav("https://convergepanel.com/login?redirect=%2Fworkspace-invitations%2Faccept");
    expect(fresh().isTelemetryFreeDocument({ performance: login, sessionStorage: store('{"version":1}') })).toBe(true);
    expect(fresh().isTelemetryFreeDocument({ performance: login, sessionStorage: store("garbage") })).toBe(true);
    expect(fresh().isTelemetryFreeDocument({ performance: login, sessionStorage: store(null) })).toBe(false);
    const throwing = {
      performance: login,
      get sessionStorage(): never {
        throw new Error("SecurityError");
      },
    } as unknown as Win;
    expect(fresh().isTelemetryFreeDocument(throwing)).toBe(false);
    expect(fresh().isTelemetryFreeDocument({ performance: login, sessionStorage: { getItem: () => { throw new Error("x"); } } })).toBe(false);
  });

  it("correction round (NIT-1): a navigation entry with a credential-shaped fragment is telemetry-free on any path (non-canonical spellings); other fragments are not", () => {
    for (const u of [
      "https://convergepanel.com/workspace-invitations/%61ccept#invitationId=i&token=t",
      "https://convergepanel.com/Workspace-Invitations/Accept#invitationId=i&token=t",
      "https://convergepanel.com/workspace-invitations//accept#token=t",
      "https://convergepanel.com/pricing#TOKEN=t",
      "https://convergepanel.com/x#a=1&InvitationId=i",
      "https://convergepanel.com/workspace-invitations/%61ccept#invitationId%3Di%26token%3Dt",
      "https://convergepanel.com/pricing#%2520token%253Dt",
    ]) {
      expect(fresh().isTelemetryFreeDocument({ performance: nav(u) })).toBe(true);
    }
    // review R6 MINOR-2: a credential key in the QUERY now also makes the document telemetry-free (asserted below).
    expect(fresh().isTelemetryFreeDocument({ performance: nav("https://convergepanel.com/pricing?token=x") })).toBe(true);
    for (const u of ["https://convergepanel.com/pricing#plans", "https://convergepanel.com/verify#text=abc", "https://convergepanel.com/pricing#"]) {
      expect(fresh().isTelemetryFreeDocument({ performance: nav(u) })).toBe(false);
    }
  });

  it("covers the trailing-slash acceptance URL and no other path; no window → false (server render)", () => {
    expect(fresh().isTelemetryFreeDocument({ performance: nav("https://convergepanel.com/workspace-invitations/accept/#x=1") })).toBe(true);
    expect(fresh().isTelemetryFreeDocument({ performance: nav("https://convergepanel.com/workspace-invitations/acceptance") })).toBe(false);
    expect(fresh().isTelemetryFreeDocument({ performance: nav("https://convergepanel.com/workspace-invitations") })).toBe(false);
    const { isTelemetryFreeDocument } = fresh();
    expect(isTelemetryFreeDocument(undefined)).toBe(false);
  });

  it("review R6: a trailing-slash acceptance navigation is telemetry-free (exact-path rule and path-prefix classifier both cover it)", () => {
    expect(fresh().isTelemetryFreeDocument({ performance: nav("https://convergepanel.com/workspace-invitations/accept/") })).toBe(true);
  });
});
