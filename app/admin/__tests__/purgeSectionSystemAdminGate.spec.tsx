/**
 * Phase FIRST-ADMIN-C3 — the bulk-purge control is SYSTEM_ADMIN only.
 *
 * `/api/admin/purge-runs` is guarded by `requireSystemAdminAccess` (the custom
 * claim only). R2 found `<PurgeRunsSection />` rendering for every ADMIN_PORTAL
 * caller, so an ADMIN_EMAILS-only administrator was offered a bulk-delete form
 * — mode, date range, dry-run toggle and a DELETE confirmation box — that the
 * server then refused with 401.
 *
 * This is a BEHAVIOURAL render assertion, not a source grep: it mounts the real
 * dashboard through the real capability hook contract and inspects the tree.
 * The server guard stays authoritative; this proves the UI stops offering an
 * action the caller cannot perform.
 */

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let capability = { canAccess: true, isSystemAdmin: false, gateReady: true, authReady: true, user: { uid: "u1" } as unknown };
const authState = { user: { uid: "u1", email: "portal@test-invented.example" }, loading: false, authReady: true, isAdmin: false, adminResolved: true };

jest.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));
jest.mock("@/hooks/useAdminPortalAccess", () => ({ useAdminPortalAccess: () => capability }));
jest.mock("@/components/admin/AdminRunsTab", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => children ?? null }));

const authedFetch = jest.fn(async () => ({ ok: true, json: async () => ({ users: [] }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => authedFetch(...(a as [])) }));

import AdminDashboard from "@/app/admin/page";

/** Renders the dashboard and returns every string in the tree. */
async function renderDashboard(): Promise<string> {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AdminDashboard />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return JSON.stringify(renderer!.toJSON());
}

const PURGE_HEADING = "Data retention cleanup";
/** Strings that only exist inside the purge form itself. */
const PURGE_CONTROLS = ["Dry run", "DELETE"];

beforeEach(() => {
  authedFetch.mockClear();
  capability = { canAccess: true, isSystemAdmin: false, gateReady: true, authReady: true, user: { uid: "u1" } };
});

describe("PurgeRunsSection is gated on SYSTEM_ADMIN", () => {
  it("THE CORE PROOF: an ADMIN_PORTAL-only admin is NOT shown the purge form", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: false };
    const tree = await renderDashboard();
    expect(tree).not.toContain(PURGE_HEADING);
    for (const control of PURGE_CONTROLS) {
      expect(tree).not.toContain(control);
    }
  });

  it("a SYSTEM_ADMIN is shown the purge form, as before", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: true };
    const tree = await renderDashboard();
    expect(tree).toContain(PURGE_HEADING);
  });

  it("an ADMIN_PORTAL-only admin never fetches the SYSTEM_ADMIN keys endpoint", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: false };
    await renderDashboard();
    const paths = authedFetch.mock.calls.map((c) => (c as unknown[])[0]);
    expect(paths).not.toContain("/api/admin/keys");
  });

  it("the provider-key tile is hidden for an ADMIN_PORTAL-only admin", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: false };
    const tree = await renderDashboard();
    expect(tree).not.toContain("Models Configured");
  });

  it("the SYSTEM_ADMIN-only user-directory link is not offered to a portal-only admin", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: false };
    const tree = await renderDashboard();
    expect(tree).not.toContain("Open user directory");
  });

  it("a SYSTEM_ADMIN still gets the user-directory link", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: true };
    const tree = await renderDashboard();
    expect(tree).toContain("Open user directory");
  });
});
