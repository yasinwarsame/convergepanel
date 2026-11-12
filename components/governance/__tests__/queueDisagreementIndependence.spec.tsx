/**
 * Fresh review of 0d4f6c9, MAJOR — GovernanceDashboard expanded research row. "Key disagreements" and "Where synthesis
 * flags disagreements" list only what the queue route returned as genuine cross-model disagreements; stored lines that
 * are not (same executing model, one independent model, independence unverified) are shown under their own heading
 * with the reason, and key findings of a run not proven independent are not presented as the panel's.
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FragmentRow, QUALIFIED_DISAGREEMENTS_HEADING, queueKeyFindingsHeading } from "@/components/governance/GovernanceDashboard";
import { QUALIFIED_DISAGREEMENT_TEXT } from "@/lib/panel/storedDisagreementIndependence";

const baseRow = {
  runId: "r1",
  collection: "runs",
  runType: "research",
  question: "When was it founded?",
  consensusScore: null,
  evidenceQuality: null,
  governanceStatus: "needs_review",
  governanceReasons: ["r"],
  modelHealth: { ok: 0, substituted: 2, failed: 0 },
  createdAt: "2026-11-01T00:00:00.000Z",
  userId: "u1",
  userEmail: "u1@test.com",
  keyFindings: ["Founded in the 1790s."],
};

function render(row: Record<string, unknown>): string {
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement("table", null,
      createElement("tbody", null,
        createElement(FragmentRow as never, {
          row: { ...baseRow, ...row },
          chip: { wrap: "", label: "Review" },
          mh: { text: "", cls: "", title: "" },
          ev: { text: "", cls: "" },
          exp: true,
          firstReason: "",
          more: "",
          consensusColor: () => "",
          expanded: new Set<string>(),
          setExpanded: noop,
          reviewBusyKey: null,
          onApprove: noop,
          onBlock: noop,
          onChanges: noop,
        } as never)
      )
    )
  );
  return html.replace(/<!-- -->/g, "");
}

beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe("GovernanceDashboard research row — disagreements by executing-model independence", () => {
  it("two DeepSeek substitutions (route output): no 'Key disagreements'; the line is shown qualified; findings not a consensus", () => {
    const html = render({
      modelIndependence: "insufficient",
      qualifiedDisagreements: [{ text: "Founding date: ChatGPT says 1789, Claude says 1792", basis: "single_independent_model" }],
    });
    expect(html).not.toContain("Key disagreements");
    expect(html).not.toContain("Where synthesis flags disagreements");
    expect(html).toContain(QUALIFIED_DISAGREEMENTS_HEADING);
    expect(html).toContain(`Founding date: ChatGPT says 1789, Claude says 1792 <span class="text-xs text-cp-faint">(${QUALIFIED_DISAGREEMENT_TEXT.single_independent_model})</span>`);
    expect(html).toContain("Key findings (synthesis — one independent model; not a consensus)");
  });

  it("DeepSeek×2 + Grok: genuine line under 'Key disagreements', same-model line qualified", () => {
    const html = render({
      disagreements: ["Founder: Different sources"],
      disagreementPoints: ["Founder"],
      qualifiedDisagreements: [{ text: "Founding date: ChatGPT says 1789, Claude says 1792", basis: "same_executing_model" }],
    });
    const key = html.slice(html.indexOf("Key disagreements"), html.indexOf(QUALIFIED_DISAGREEMENTS_HEADING));
    expect(key).toContain("Founder: Different sources");
    expect(key).not.toContain("1789");
    expect(html).toContain(QUALIFIED_DISAGREEMENT_TEXT.same_executing_model);
    expect(html).toContain("Key findings (synthesis)</p>");
  });

  it("missing provenance: findings heading and qualified line say independence unverified", () => {
    const html = render({ modelIndependence: "unverified", qualifiedDisagreements: [{ text: "Founding date", basis: "independence_unverified" }] });
    expect(html).toContain("Key findings (synthesis — model independence unverified)");
    expect(html).toContain(QUALIFIED_DISAGREEMENT_TEXT.independence_unverified);
    expect(html).not.toContain("Key disagreements");
  });

  it("queueKeyFindingsHeading", () => {
    expect(queueKeyFindingsHeading({})).toBe("Key findings (synthesis)");
    expect(queueKeyFindingsHeading({ modelIndependence: "insufficient" })).toBe("Key findings (synthesis — one independent model; not a consensus)");
    expect(queueKeyFindingsHeading({ modelIndependence: "unverified" })).toBe("Key findings (synthesis — model independence unverified)");
  });
});
