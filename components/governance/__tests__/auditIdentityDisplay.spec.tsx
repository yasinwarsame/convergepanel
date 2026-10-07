/**
 * Roadmap 4.1 (C1 + C3) — Governance Audit Log identity presentation.
 *
 * 1. The pure functions: "You" by uid, never a raw uid, never an invented
 *    name, one neutral label when nothing is legitimately resolvable.
 * 2. The real AuditLogEventCard, rendered with its trail expanded, for every
 *    displayed action: the actor text in the list card and in the trail is
 *    the SAME string, and no uid or "Unknown user" reaches the markup.
 */

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AUDIT_IDENTITY_UNAVAILABLE_LABEL,
  auditActorDisplay,
  auditRunOwnerDisplay,
} from "@/components/governance/auditIdentityDisplay";
import { AuditLogEventCard } from "@/components/governance/GovernanceDashboard";

const VIEWER_UID = "uid-SENTINEL-VIEWER-91c2";
const OTHER_UID = "uid-SENTINEL-OTHER-5d0e";
const VIEWER = { uid: VIEWER_UID, email: "viewer.person@example.com" };

describe("auditActorDisplay", () => {
  it("viewer by uid -> You, even with no byEmail (adaptive rows)", () => {
    expect(auditActorDisplay({ byUid: VIEWER_UID }, VIEWER)).toBe("You");
    expect(auditActorDisplay({ byUid: VIEWER_UID, byEmail: "" }, VIEWER)).toBe("You");
  });
  it("viewer by email (case-insensitive) -> You", () => {
    expect(auditActorDisplay({ byUid: OTHER_UID, byEmail: "Viewer.Person@Example.com" }, VIEWER)).toBe("You");
  });
  it("another person's email -> masked email", () => {
    expect(auditActorDisplay({ byUid: OTHER_UID, byEmail: "someone.else@example.com" }, VIEWER)).toBe("som***@example.com");
  });
  it("system actor -> System", () => {
    expect(auditActorDisplay({ byUid: "system", byEmail: "system" }, VIEWER)).toBe("System");
    expect(auditActorDisplay({ byUid: "x", byEmail: "system@convergepanel.com" }, VIEWER)).toBe("System");
  });
  it.each([
    ["foreign uid, no email", { byUid: OTHER_UID }],
    ["foreign uid, uid in email field", { byUid: OTHER_UID, byEmail: OTHER_UID }],
    ["nothing at all", {}],
  ])("%s -> the neutral label, never the uid", (_l, ev) => {
    const out = auditActorDisplay(ev, VIEWER);
    expect(out).toBe(AUDIT_IDENTITY_UNAVAILABLE_LABEL);
    expect(out).not.toContain(OTHER_UID);
  });
  it("a viewer with no uid on the client never matches an empty byUid", () => {
    expect(auditActorDisplay({ byUid: "" }, { uid: "", email: null })).toBe(AUDIT_IDENTITY_UNAVAILABLE_LABEL);
  });
});

describe("auditRunOwnerDisplay", () => {
  it("runOwnerIsViewer -> You", () => {
    expect(auditRunOwnerDisplay({ runOwnerIsViewer: true }, VIEWER)).toBe("You");
  });
  it("viewer's own email -> You", () => {
    expect(auditRunOwnerDisplay({ runOwnerEmail: "viewer.person@example.com" }, VIEWER)).toBe("You");
  });
  it("another email -> masked", () => {
    expect(auditRunOwnerDisplay({ runOwnerEmail: "owner.person@example.com" }, VIEWER)).toBe("own***@example.com");
  });
  it.each([
    ["absent", {}],
    ["empty", { runOwnerEmail: "" }],
    ["uid in the email field", { runOwnerEmail: OTHER_UID }],
  ])("%s -> the neutral label", (_l, ev) => {
    expect(auditRunOwnerDisplay(ev, VIEWER)).toBe(AUDIT_IDENTITY_UNAVAILABLE_LABEL);
  });
  it("the label is the agreed neutral wording", () => {
    expect(AUDIT_IDENTITY_UNAVAILABLE_LABEL).toBe("Not available");
  });
});

const DISPLAYED_ACTIONS = [
  "approved",
  "blocked",
  "changes_requested",
  "policy_updated",
  "adaptive_human_review_decided",
  "adaptive_human_review_reviewer_assigned",
  "adaptive_human_review_reviewer_reassigned",
  "adaptive_human_review_reviewer_unassigned",
  "adaptive_review_panel_finalized",
  "adaptive_review_panel_owner_overridden",
  "adaptive_export_generated",
  "adaptive_export_generation_failed",
  "adaptive_export_regenerated",
];

const ACTOR_CASES: Array<[string, Record<string, unknown>, string]> = [
  ["viewer by uid, no email", { byUid: VIEWER_UID }, "You"],
  ["another person's email", { byUid: OTHER_UID, byEmail: "someone.else@example.com" }, "som***@example.com"],
  ["foreign uid, no email", { byUid: OTHER_UID }, "Not available"],
];

function renderCard(ev: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(AuditLogEventCard as any, {
      ev,
      inlineTrail: { eventId: ev.id, runId: ev.runId, collection: "runs", events: [ev], loading: false, error: null },
      onToggleTrail: () => undefined,
      viewer: VIEWER,
    })
  );
}

function decode(s: string): string {
  return s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** The actor string rendered in the card body, located by its own label. */
function cardActor(html: string, action: string): string {
  const label = action === "policy_updated" ? "Updated by:" : "[^<]*by:|[^<]*:";
  const re = new RegExp(`<span class="font-medium text-cp-muted">(?:${label})</span> <span class="text-cp-text">([^<]*)</span>`, "g");
  const hits = [...html.matchAll(re)].map((m) => decode(m[1]));
  // Card body order: "Run by" (non-policy rows) then the actor line.
  return hits[hits.length - 1];
}

function trailActor(html: string): string {
  const m = html.match(/<p class="mt-0\.5 text-cp-muted">by ([^<]*)<\/p>/);
  return m ? decode(m[1]) : "";
}

describe.each(DISPLAYED_ACTIONS)("AuditLogEventCard — %s", (action) => {
  it.each(ACTOR_CASES)("actor %s: list card and trail render the same string", (_l, actor, expected) => {
    const ev = { id: "ev-1", action, at: "2026-10-01T00:00:00.000Z", runId: "run-1", collection: "runs", ...actor };
    const html = renderCard(ev);
    expect(cardActor(html, action)).toBe(expected);
    expect(trailActor(html)).toBe(expected);
    expect(html).not.toContain(VIEWER_UID);
    expect(html).not.toContain(OTHER_UID);
    expect(html).not.toContain("Unknown user");
  });

  if (action !== "policy_updated") {
    it.each([
      ["owner is viewer", { runOwnerIsViewer: true }, "You"],
      ["owner email", { runOwnerEmail: "owner.person@example.com" }, "own***@example.com"],
      ["owner withheld", {}, "Not available"],
      ["uid in the owner email field", { runOwnerEmail: OTHER_UID }, "Not available"],
    ])("Run by — %s", (_l, owner, expected) => {
      const ev = { id: "ev-1", action, at: "2026-10-01T00:00:00.000Z", runId: "run-1", collection: "runs", byUid: VIEWER_UID, ...owner };
      const html = renderCard(ev);
      const m = html.match(/<span class="font-medium text-cp-muted">Run by:<\/span> <span class="text-cp-text">([^<]*)<\/span>/);
      expect(m && decode(m[1])).toBe(expected);
      expect(html).not.toContain(OTHER_UID);
      expect(html).not.toContain("Unknown user");
    });
  }
});
