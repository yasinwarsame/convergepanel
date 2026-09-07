/**
 * Phase FIRST-ADMIN-C6 — the REAL AdminRunsTab, not a stub.
 *
 * C5-R2 found the Override/Delete SYSTEM_ADMIN gates pinned by nothing:
 * removing them, weakening them to `canAccess`, or inverting them all passed the
 * entire suite. The only test file that mentioned this component
 * (`app/admin/__tests__/purgeSectionSystemAdminGate.spec.tsx:24`) STUBS it to
 * `() => null`, so it structurally could not cover the gates.
 *
 * This renders the real component. Override (PATCH) and Delete (DELETE) on
 * `/api/admin/runs/[runId]` are SYSTEM_ADMIN; View (GET) stays ADMIN_PORTAL, so
 * a portal operator keeps the read capability and is simply not offered the two
 * mutations the server would refuse. The server guards remain authoritative —
 * these gates are affordances, and the point of the test is that a regression in
 * them is visible rather than silent.
 */

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let capability = { canAccess: true, isSystemAdmin: false, gateReady: true, authReady: true, user: { uid: "u1" } as unknown };
const authState = { user: { uid: "u1", email: "admin@test-invented.example" }, loading: false, authReady: true, isAdmin: false, adminResolved: true };

jest.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));
jest.mock("@/hooks/useAdminPortalAccess", () => ({ useAdminPortalAccess: () => capability }));

const ROW = {
  runId: "run-1",
  collection: "runs",
  runType: "research",
  question: "a question that belongs to a customer",
  userEmail: "owner@test-invented.example",
  userId: "owner-a",
  createdAt: new Date("2026-09-01T00:00:00Z").toISOString(),
  governanceStatus: "needs_review",
  consensusScore: 50,
};
const authedFetch = jest.fn(async () => ({
  ok: true,
  json: async () => ({ ok: true, runs: [ROW], total: 1 }),
}));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => authedFetch(...(a as [])) }));

import AdminRunsTab from "@/components/admin/AdminRunsTab";

/** Every button label rendered in the tree. */
function buttonLabels(node: TestRenderer.ReactTestRenderer): string[] {
  return node.root
    .findAllByType("button")
    .map((b) => b.children.filter((c): c is string => typeof c === "string").join("").trim())
    .filter(Boolean);
}

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<AdminRunsTab />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return r;
}

beforeEach(() => {
  authedFetch.mockClear();
  capability = { canAccess: true, isSystemAdmin: false, gateReady: true, authReady: true, user: { uid: "u1" } };
});

describe("AdminRunsTab capability gates (real component)", () => {
  it("FIXTURE SELF-VALIDATION: a row really renders, so a hidden control means hidden", async () => {
    // Without this, "Override is absent" would pass on an empty table.
    capability = { ...capability, isSystemAdmin: true };
    const tree = await render();
    expect(JSON.stringify(tree.toJSON())).toContain("a question that belongs to a customer");
    expect(buttonLabels(tree)).toContain("View");
  });

  it("THE CORE PROOF: ADMIN_PORTAL-only sees View, but NOT Override or Delete", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: false };
    const tree = await render();
    const labels = buttonLabels(tree);
    expect(labels).toContain("View");
    expect(labels).not.toContain("Override");
    expect(labels).not.toContain("Delete");
  });

  it("SYSTEM_ADMIN sees View, Override and Delete", async () => {
    capability = { ...capability, canAccess: true, isSystemAdmin: true };
    const labels = buttonLabels(await render());
    expect(labels).toEqual(expect.arrayContaining(["View", "Override", "Delete"]));
  });

  it("the portal read capability is genuinely retained — the list is still fetched", async () => {
    capability = { ...capability, isSystemAdmin: false };
    await render();
    const paths = authedFetch.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(paths.some((p) => p.startsWith("/api/admin/runs?"))).toBe(true);
  });
});
