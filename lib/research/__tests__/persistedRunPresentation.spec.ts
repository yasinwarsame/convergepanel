/**
 * TEAM-RESEARCH-PARITY-R2 §D–§J/§T — `interpretPersistedRunReadPayload()`.
 * Real adapters, real fixtures (the same parser-valid envelopes the server
 * suites use). This helper is pure: no network, no React, no authorization.
 */
import {
  interpretPersistedRunReadPayload,
  MALFORMED_STRUCTURED_RESULT_NOTICE,
  NEWER_VERSION_STRUCTURED_RESULT_NOTICE,
  PERSISTED_RUN_VIEWER_ROLES,
} from "@/lib/research/persistedRunPresentation";
import { deepResearchAdaptiveOutput, legacyAdaptiveOutput } from "@/lib/runs/__tests__/runReadFixtures";

const RUN = "run-7";
const rows = (n = 2) => Array.from({ length: n }, (_, i) => ({ modelId: ["chatgpt", "claude", "grok"][i], status: "ok", rawText: `a${i}` }));
const okRun = (over: Record<string, unknown> = {}) => ({
  ok: true,
  runId: RUN,
  question: "What changed?",
  status: "complete",
  viewerRole: "owner",
  results: rows(),
  adaptive: { status: "absent", output: null, humanReview: null, reviewRouting: "unknown" },
  legacyAdaptive: { status: "absent", output: null },
  synthesisCache: null,
  governance: null,
  governanceStatus: null,
  ...over,
});
const ready = (raw: unknown) => {
  const r = interpretPersistedRunReadPayload(raw, RUN);
  if (r.kind !== "ready") throw new Error(`expected ready, got ${r.kind}`);
  return r.presentation;
};

describe("response identity (§E)", () => {
  it("valid owner ordinary run → ready with the response's own id and role", () => {
    const p = ready(okRun());
    expect(p.runId).toBe(RUN);
    expect(p.viewerRole).toBe("owner");
    expect(p.question).toBe("What changed?");
    expect(p.results).toHaveLength(2);
    expect(p.adaptive).toBeNull();
    expect(p.restoreNotice).toBeNull();
  });

  it.each(PERSISTED_RUN_VIEWER_ROLES)("accepts exactly the four roles — %s", (role) => {
    expect(ready(okRun({ viewerRole: role })).viewerRole).toBe(role);
  });

  it.each([undefined, null, "", "admin", "member", "OWNER", 1, {}])("missing/unknown viewerRole %p → malformed (never defaulted)", (role) => {
    expect(interpretPersistedRunReadPayload(okRun({ viewerRole: role }), RUN)).toEqual({ kind: "malformed" });
  });

  it.each([undefined, null, "", 7])("missing/non-string runId %p → malformed", (id) => {
    expect(interpretPersistedRunReadPayload(okRun({ runId: id }), RUN)).toEqual({ kind: "malformed" });
  });

  it("a runId different from the requested id → malformed (identity is never manufactured from the request)", () => {
    expect(interpretPersistedRunReadPayload(okRun({ runId: "run-8" }), RUN)).toEqual({ kind: "malformed" });
  });

  it.each([null, undefined, "string", 3, [], { ok: false }, { ok: "true", runId: RUN, viewerRole: "owner" }])("non-object or ok!==true %p → malformed", (raw) => {
    expect(interpretPersistedRunReadPayload(raw, RUN)).toEqual({ kind: "malformed" });
  });
});

describe("status contract (§F)", () => {
  it.each(["queued", "running"])("%s → in_progress, carrying question and role, no interpretation attempted", (status) => {
    expect(interpretPersistedRunReadPayload(okRun({ status, results: [] }), RUN)).toEqual({ kind: "in_progress", question: "What changed?", viewerRole: "owner" });
  });
  it.each(["error", "failed"])("%s → failed, carrying question and role", (status) => {
    expect(interpretPersistedRunReadPayload(okRun({ status, results: [], viewerRole: "team_member" }), RUN)).toEqual({ kind: "failed", question: "What changed?", viewerRole: "team_member" });
  });
  it("a non-string question degrades to an empty string", () => {
    expect(interpretPersistedRunReadPayload(okRun({ status: "queued", question: 5 }), RUN)).toEqual({ kind: "in_progress", question: "", viewerRole: "owner" });
  });
});

describe("envelope order (§G/§H/§I)", () => {
  it("valid adaptive → adapted through adaptPersistedOutputToPanelPayload with governance context", () => {
    const p = ready(okRun({ adaptive: { status: "valid", output: deepResearchAdaptiveOutput(), humanReview: { status: "unreviewed" }, reviewRouting: "in_queue" } }));
    expect(p.adaptive?.schemaId).toBe("deep_research");
    expect(p.adaptive?.deepResearch).toEqual(deepResearchAdaptiveOutput().result);
    expect(p.adaptive?.persistenceStatus).toBe("saved");
    expect(p.adaptive?.humanReview).toEqual({ status: "unreviewed" });
    expect(p.adaptive?.reviewRouting).toBe("in_queue");
    expect(p.restoreNotice).toBeNull();
  });

  it("valid legacy adaptive (adaptive absent) → adapted through adaptPersistedLegacyOutputToPanelPayload, rows carried", () => {
    const p = ready(okRun({ legacyAdaptive: { status: "valid", output: legacyAdaptiveOutput() } }));
    expect(p.adaptive?.schemaId).toBe("procedural");
    expect(p.adaptive?.results).toEqual(legacyAdaptiveOutput().results);
    expect(p.adaptive?.synthesisReport).toEqual({ unifiedAnswer: "Unified" });
    expect(p.restoreNotice).toBeNull();
  });

  it("adaptive valid AND legacy valid → adaptive wins", () => {
    const p = ready(okRun({ adaptive: { status: "valid", output: deepResearchAdaptiveOutput() }, legacyAdaptive: { status: "valid", output: legacyAdaptiveOutput() } }));
    expect(p.adaptive?.schemaId).toBe("deep_research");
  });

  it("adaptive absent + legacy valid → legacy wins ('absent' alone is not proof of an ordinary run)", () => {
    const p = ready(okRun({ adaptive: { status: "absent", output: null }, legacyAdaptive: { status: "valid", output: legacyAdaptiveOutput() } }));
    expect(p.adaptive?.schemaId).toBe("procedural");
  });

  it.each(["adaptive", "legacyAdaptive"])("%s malformed + raw rows → malformed restore notice + raw rows, no structured presentation", (field) => {
    const p = ready(okRun({ [field]: { status: "malformed", output: null } }));
    expect(p.adaptive).toBeNull();
    expect(p.restoreNotice).toBe(MALFORMED_STRUCTURED_RESULT_NOTICE);
    expect(p.results).toHaveLength(2);
  });

  it.each(["adaptive", "legacyAdaptive"])("%s unsupported_version + raw rows → newer-version notice + raw rows", (field) => {
    const p = ready(okRun({ [field]: { status: "unsupported_version", output: null } }));
    expect(p.adaptive).toBeNull();
    expect(p.restoreNotice).toBe(NEWER_VERSION_STRUCTURED_RESULT_NOTICE);
  });

  it("malformed takes precedence over unsupported_version when both are present", () => {
    const p = ready(okRun({ adaptive: { status: "unsupported_version", output: null }, legacyAdaptive: { status: "malformed", output: null } }));
    expect(p.restoreNotice).toBe(MALFORMED_STRUCTURED_RESULT_NOTICE);
  });

  it("a valid structured envelope suppresses any restore notice from the other envelope", () => {
    const p = ready(okRun({ adaptive: { status: "valid", output: deepResearchAdaptiveOutput() }, legacyAdaptive: { status: "malformed", output: null } }));
    expect(p.restoreNotice).toBeNull();
    expect(p.adaptive?.schemaId).toBe("deep_research");
  });

  it("a valid-status envelope with a null output is NOT used (falls through)", () => {
    const p = ready(okRun({ adaptive: { status: "valid", output: null } }));
    expect(p.adaptive).toBeNull();
    expect(p.restoreNotice).toBeNull();
  });

  it("completed with no structured output and no rows → malformed (never 'you haven't run this yet')", () => {
    expect(interpretPersistedRunReadPayload(okRun({ results: [] }), RUN)).toEqual({ kind: "malformed" });
    expect(interpretPersistedRunReadPayload(okRun({ results: undefined }), RUN)).toEqual({ kind: "malformed" });
    expect(interpretPersistedRunReadPayload(okRun({ results: [], adaptive: { status: "malformed", output: null } }), RUN)).toEqual({ kind: "malformed" });
  });

  it("completed with a valid structured result and zero rows is still ready (Milestone-2 envelopes carry no rows)", () => {
    const p = ready(okRun({ results: [], adaptive: { status: "valid", output: deepResearchAdaptiveOutput() } }));
    expect(p.results).toEqual([]);
    expect(p.adaptive?.schemaId).toBe("deep_research");
  });
});

describe("synthesis and governance passthrough (§J)", () => {
  it("persisted synthesis present → report and consensus summary passed through", () => {
    const p = ready(okRun({ synthesisCache: { report: { headline: "R" }, schemaVersion: 1, synthesizedBy: "cached", consensusSummary: { agreement: 0.5 } } }));
    expect(p.synthesisReport).toEqual({ headline: "R" });
    expect(p.synthesisConsensusSummary).toEqual({ agreement: 0.5 });
  });
  it("persisted synthesis absent → both null (never generated here)", () => {
    const p = ready(okRun({ synthesisCache: null }));
    expect(p.synthesisReport).toBeNull();
    expect(p.synthesisConsensusSummary).toBeNull();
  });
  it.each(["approved", "needs_review", "blocked"])("governance status %s is kept", (og) => {
    expect(ready(okRun({ governanceStatus: og })).orgGovernanceStatus).toBe(og);
  });
  it.each(["weird", "", 1, null, undefined])("governance status %p → null", (og) => {
    expect(ready(okRun({ governanceStatus: og })).orgGovernanceStatus).toBeNull();
  });
  it("the governance banner projection passes through as emitted; absent → undefined", () => {
    expect(ready(okRun({ governance: { governanceReviewRequired: true, blockedByPolicy: false, policyFlags: ["pii"] } })).governance).toEqual({ governanceReviewRequired: true, blockedByPolicy: false, policyFlags: ["pii"] });
    expect(ready(okRun({ governance: null })).governance).toBeUndefined();
    expect(ready(okRun({ governance: undefined })).governance).toBeUndefined();
  });
});

describe("robustness", () => {
  it("malformed optional fields cannot crash interpretation", () => {
    const junk = okRun({ adaptive: "nope", legacyAdaptive: 42, synthesisCache: "x", governance: 7, governanceStatus: [], results: rows(1), selectedModels: "x" });
    expect(() => interpretPersistedRunReadPayload(junk, RUN)).not.toThrow();
    const p = ready(junk);
    expect(p.adaptive).toBeNull();
    expect(p.synthesisReport).toBeNull();
    expect(p.orgGovernanceStatus).toBeNull();
  });

  it("does not mutate its input", () => {
    const raw = okRun({ adaptive: { status: "valid", output: deepResearchAdaptiveOutput() } });
    const before = JSON.stringify(raw);
    interpretPersistedRunReadPayload(raw, RUN);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("Team roles are interpreted exactly like Personal roles — containment is the caller's decision, not this helper's", () => {
    const owner = ready(okRun({ viewerRole: "owner" }));
    const team = ready(okRun({ viewerRole: "team_reviewer" }));
    expect({ ...team, viewerRole: "owner" }).toEqual(owner);
  });
});
