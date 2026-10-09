/**
 * Step 6 D5.2A — "Consensus thresholds by score type" and the Dashboard save patch.
 *
 * Every control must correspond to enforced behaviour: default (shared) review
 * threshold, video and research overrides, NO claim control, legacy approval
 * value read-only. Family inputs are editable only when the server reports the
 * write capability, so a flag-off save can never appear to set one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import ScoreTypeThresholdsSection, { withFamilyThreshold } from "@/components/governance/ScoreTypeThresholdsSection";
import { buildPolicyPatch } from "@/components/governance/policyPatch";
import { getDefaultGovernancePolicy, type GovernancePolicy } from "@/lib/governance/evaluateGovernance";

const base = (): GovernancePolicy => getDefaultGovernancePolicy();
const html = (policy: GovernancePolicy, opts: { isAdminUser?: boolean; familyWritesEnabled?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(ScoreTypeThresholdsSection, {
      policy,
      isAdminUser: opts.isAdminUser ?? true,
      familyWritesEnabled: opts.familyWritesEnabled ?? false,
      onChange: () => undefined,
    })
  );

function render(policy: GovernancePolicy, familyWritesEnabled: boolean, isAdminUser = true) {
  const onChange = jest.fn();
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(createElement(ScoreTypeThresholdsSection, { policy, isAdminUser, familyWritesEnabled, onChange }));
  });
  const inputs = r.root.findAll((n) => n.type === "input");
  return { r, onChange, inputs };
}

describe("copy and controls", () => {
  const out = html(base());
  it("heading and the non-equivalence explanation", () => {
    expect(out).toContain("Consensus thresholds by score type");
    expect(out).toContain("Claim, video and research scores use different formulas. The same number does not mean the same thing across them.");
  });
  it("default review threshold with its fallback meaning", () => {
    expect(out).toContain("Default review threshold");
    expect(out).toContain("Used when a score type does not have its own review threshold.");
  });
  it("video and research controls exist and say 'Uses default (70)' when absent", () => {
    expect(out).toContain("Video verification review threshold");
    expect(out).toContain("Research synthesis review threshold");
    expect(out.match(/Uses default \(70\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("the 'uses default' text follows the shared value", () => {
    expect(html({ ...base(), minConsensusToAvoidReview: 64 })).toContain("Uses default (64)");
  });
  it("claims have explanatory text and NO control", () => {
    expect(out).toContain("Claim verification");
    expect(out).toContain("The general score threshold is not decision-binding for current claim verification behavior.");
    expect(out).not.toMatch(/claim[^<]*review threshold/i);
    const { inputs } = render(base(), true);
    expect(inputs).toHaveLength(3); // default + video + research — no claim input
  });
  it("legacy approval value is shown read-only and explained", () => {
    expect(out).toContain("Legacy approval value");
    expect(out).toContain("Stored for backward compatibility. It is not currently used to make a governance decision.");
    const { inputs } = render(base(), true);
    expect(inputs.some((i) => i.props.value === 80)).toBe(false);
  });
});

describe("editability", () => {
  it("flag OFF: family inputs are disabled and the reason is shown; the default stays editable", () => {
    const { inputs, r } = render(base(), false);
    const [shared, video, research] = inputs;
    expect(shared.props.disabled).toBe(false);
    expect(video.props.disabled).toBe(true);
    expect(research.props.disabled).toBe(true);
    expect(r.root.findAll((n) => n.props["data-testid"] === "family-writes-disabled")).toHaveLength(1);
  });
  it("flag ON + admin: family inputs editable, no disabled notice", () => {
    const { inputs, r } = render(base(), true);
    expect(inputs[1].props.disabled).toBe(false);
    expect(inputs[2].props.disabled).toBe(false);
    expect(r.root.findAll((n) => n.props["data-testid"] === "family-writes-disabled")).toHaveLength(0);
  });
  it("flag ON but not admin: nothing editable", () => {
    const { inputs } = render(base(), true, false);
    expect(inputs.every((i) => i.props.disabled === true)).toBe(true);
  });
  it("editing video sets only video; blanking it removes the override", () => {
    const { inputs, onChange } = render({ ...base(), scoreFamilyReviewThresholds: { research_synthesis_v1: 80 } }, true);
    act(() => inputs[1].props.onChange({ target: { value: "72" } }));
    expect(onChange.mock.calls[0][0].scoreFamilyReviewThresholds).toEqual({ research_synthesis_v1: 80, video_agreement_v1: 72 });
    const cleared = withFamilyThreshold({ ...base(), scoreFamilyReviewThresholds: { video_agreement_v1: 72 } }, "video_agreement_v1", "");
    expect("scoreFamilyReviewThresholds" in cleared).toBe(false);
  });
});

describe("buildPolicyPatch (Dashboard save body)", () => {
  it("no change → empty patch", () => {
    expect(buildPolicyPatch(base(), base())).toEqual({});
  });
  it("family set / clear are sent per family in mutation form", () => {
    const baseline = { ...base(), scoreFamilyReviewThresholds: { video_agreement_v1: 75, research_synthesis_v1: 80 } };
    const edited = { ...base(), scoreFamilyReviewThresholds: { research_synthesis_v1: 82 } };
    expect(buildPolicyPatch(edited, baseline)).toEqual({ scoreFamilyReviewThresholds: { video_agreement_v1: null, research_synthesis_v1: 82 } });
  });
  it("an untouched family is never sent", () => {
    const baseline = { ...base(), scoreFamilyReviewThresholds: { research_synthesis_v1: 80 } };
    const edited = { ...baseline, scoreFamilyReviewThresholds: { research_synthesis_v1: 80, video_agreement_v1: 77 } };
    expect(buildPolicyPatch(edited, baseline)).toEqual({ scoreFamilyReviewThresholds: { video_agreement_v1: 77 } });
  });
  it("the legacy approval value is never sent, even if it differs", () => {
    expect(buildPolicyPatch({ ...base(), minConsensusToApprove: 90 }, base())).toEqual({});
  });
  it("legacy fields are still diffed", () => {
    expect(buildPolicyPatch({ ...base(), minConsensusToAvoidReview: 66, sensitiveMinConsensusToApprove: 88 }, base())).toEqual({
      minConsensusToAvoidReview: 66,
      sensitiveMinConsensusToApprove: 88,
    });
  });
});
