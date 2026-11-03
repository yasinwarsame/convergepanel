/**
 * Governance audit trail access (owner decision 2026-11-04): the Audit tab card offers "Open trail →" ONLY when the
 * server marked the row `trailAvailable: true`. A row whose trail can't be opened (for example a former reviewer's
 * historical action) is still listed, without an active control, with a short explanation that names no owner and no
 * research content. Policy rows have no trail and show neither.
 */

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AUDIT_TRAIL_UNAVAILABLE_COPY, AuditLogEventCard } from "@/components/governance/GovernanceDashboard";

const VIEWER = { uid: "uid-viewer", email: "viewer@example.com" };

function card(ev: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(AuditLogEventCard as any, { ev, inlineTrail: null, onToggleTrail: () => undefined, viewer: VIEWER })
  ).replace(/&#x27;/g, "'");
}
const base = { id: "e1", action: "approved", byUid: "uid-viewer", byEmail: "", at: "2026-11-03T21:00:00.000Z", runId: "run-1", collection: "runs", question: "q" };
const hasButton = (html: string) => /<button[^>]*>[^<]*Open trail/.test(html);

describe("trail control", () => {
  it("trailAvailable: true -> active control, no explanation", () => {
    const html = card({ ...base, trailAvailable: true });
    expect(hasButton(html)).toBe(true);
    expect(html).not.toContain(AUDIT_TRAIL_UNAVAILABLE_COPY);
  });

  it("trailAvailable: false -> no control, the explanation instead, and the row is still rendered", () => {
    const html = card({ ...base, trailAvailable: false });
    expect(hasButton(html)).toBe(false);
    expect(html).toContain(AUDIT_TRAIL_UNAVAILABLE_COPY);
    expect(html).toContain("APPROVED");
  });

  it("missing trailAvailable (unknown) fails closed: no control", () => {
    const html = card({ ...base });
    expect(hasButton(html)).toBe(false);
    expect(html).toContain(AUDIT_TRAIL_UNAVAILABLE_COPY);
  });

  it("policy rows have no trail: neither control nor explanation", () => {
    const html = card({ id: "p1", action: "policy_updated", byUid: "uid-viewer", byEmail: "", at: "2026-11-03T21:00:00.000Z", runId: "policy", trailAvailable: true });
    expect(hasButton(html)).toBe(false);
    expect(html).not.toContain(AUDIT_TRAIL_UNAVAILABLE_COPY);
  });

  it("the explanation is fixed copy: it names no owner, reviewer or assignment", () => {
    expect(AUDIT_TRAIL_UNAVAILABLE_COPY).not.toMatch(/@|owner|assign|revok|former/i);
  });
});
