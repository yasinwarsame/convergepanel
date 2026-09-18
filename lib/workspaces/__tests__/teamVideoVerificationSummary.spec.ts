/**
 * TEAM-VERIFICATION-PARITY-R5-I1 §AF — the Team Video LIST summary DTO is
 * STRICT: it never inherits the detail mapper's tolerant fallbacks
 * ("Uploaded video", "inconclusive", 0, "Low", "weak"), and it never emits a
 * private field.
 */

import { toTeamVideoVerificationSummary, teamVideoTimestampIso } from "@/lib/workspaces/teamVideoVerificationSummary";

const W = "ws-team-1";
const TS = { seconds: 1_700_000_000, nanoseconds: 123_000_000 };

const VALID: Record<string, unknown> = {
  userId: "uploader-a",
  userEmail: "uploader-a@example.com",
  type: "video_verification",
  fileName: "clip.mp4",
  verdict: "authentic_captured",
  contentType: "camera_footage",
  consensusScore: 88,
  confidenceLabel: "High",
  evidenceQuality: "strong",
  frameCount: 8,
  totalTokens: 4321,
  metadata: { fileSize: 1024 },
  modelResults: [{ modelId: "chatgpt" }],
  timestamp: TS,
};

function build(overrides: Record<string, unknown> = {}, args: Partial<Parameters<typeof toTeamVideoVerificationSummary>[0]> = {}) {
  const data = { ...VALID, ...overrides };
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete (data as Record<string, unknown>)[k];
  return toTeamVideoVerificationSummary({ verificationId: "vid-1", data, workspaceId: W, projectId: null, project: null, ...args });
}

describe("accepted rows", () => {
  it("Unfiled row maps every required field and no others", () => {
    expect(build()).toEqual({
      verificationId: "vid-1",
      fileName: "clip.mp4",
      verdict: "authentic_captured",
      contentType: "camera_footage",
      consensusScore: 88,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      frameCount: 8,
      createdAt: "2023-11-14T22:13:20.123Z",
      workspaceId: W,
      projectId: null,
      project: null,
    });
  });

  it("filed row carries the Project label and keeps its projectId", () => {
    const s = build({}, { projectId: "p1", project: { id: "p1", name: "Q4", status: "active" } });
    expect(s?.projectId).toBe("p1");
    expect(s?.project).toEqual({ id: "p1", name: "Q4", status: "active" });
  });

  it("an ARCHIVED Project label is valid and reports its real status", () => {
    expect(build({}, { projectId: "p1", project: { id: "p1", name: "Old", status: "archived" } })?.project?.status).toBe("archived");
  });

  it.each(["authentic_captured", "authentic_produced", "likely_manipulated", "inconclusive", "insufficient"])("canonical aggregate verdict %s is accepted", (verdict) => {
    expect(build({ verdict })?.verdict).toBe(verdict);
  });

  it('the legacy aggregate verdict "authentic" is preserved (the shared result view still renders it)', () => {
    expect(build({ verdict: "authentic" })?.verdict).toBe("authentic");
  });

  it("optional contentType is omitted, not fabricated, when absent", () => {
    const s = build({ contentType: undefined });
    expect(s).not.toBeNull();
    expect("contentType" in (s as object)).toBe(false);
  });

  it.each(["approved", "needs_review", "blocked"])("optional governanceStatus %s is emitted when present", (governanceStatus) => {
    expect(build({ governanceStatus })?.governanceStatus).toBe(governanceStatus);
  });

  it("governanceStatus is omitted when absent or explicitly null", () => {
    expect("governanceStatus" in (build() as object)).toBe(false);
    expect("governanceStatus" in (build({ governanceStatus: null }) as object)).toBe(false);
  });

  it.each([0, 100])("consensusScore boundary %i is accepted", (consensusScore) => {
    expect(build({ consensusScore })?.consensusScore).toBe(consensusScore);
  });

  it("frameCount 0 is accepted (a real value, not a fallback)", () => {
    expect(build({ frameCount: 0 })?.frameCount).toBe(0);
  });
});

describe("rejected rows — a malformed field fails the ROW, never defaults", () => {
  it.each([
    ["fileName empty", { fileName: "" }],
    ["fileName absent", { fileName: undefined }],
    ["fileName non-string", { fileName: 12 }],
    ["verdict unknown", { verdict: "totally_fine" }],
    ["verdict absent", { verdict: undefined }],
    ["verdict non-string", { verdict: 3 }],
    ["consensusScore NaN", { consensusScore: Number.NaN }],
    ["consensusScore Infinity", { consensusScore: Number.POSITIVE_INFINITY }],
    ["consensusScore below range", { consensusScore: -1 }],
    ["consensusScore above range", { consensusScore: 101 }],
    ["consensusScore absent", { consensusScore: undefined }],
    ["consensusScore non-number", { consensusScore: "88" }],
    ["confidenceLabel unknown", { confidenceLabel: "high" }],
    ["confidenceLabel absent", { confidenceLabel: undefined }],
    ["evidenceQuality unknown", { evidenceQuality: "excellent" }],
    ["evidenceQuality absent", { evidenceQuality: undefined }],
    ["frameCount negative", { frameCount: -1 }],
    ["frameCount non-integer", { frameCount: 2.5 }],
    ["frameCount NaN", { frameCount: Number.NaN }],
    ["frameCount absent", { frameCount: undefined }],
    ["frameCount non-number", { frameCount: "8" }],
    ["timestamp absent", { timestamp: undefined }],
    ["timestamp a string", { timestamp: "2023-11-14T22:13:20.000Z" }],
    ["timestamp seconds non-numeric", { timestamp: { seconds: "1", nanoseconds: 0 } }],
    ["timestamp nanoseconds out of range", { timestamp: { seconds: 1, nanoseconds: 1_000_000_000 } }],
    ["timestamp nanoseconds negative", { timestamp: { seconds: 1, nanoseconds: -1 } }],
    ["contentType present but empty", { contentType: "" }],
    ["contentType present but non-string", { contentType: 7 }],
    ["governanceStatus unrecognized", { governanceStatus: "pending" }],
  ])("%s -> null", (_label, overrides) => {
    expect(build(overrides as Record<string, unknown>)).toBeNull();
  });

  it.each([
    ["verificationId empty", { verificationId: "" }],
    ["workspaceId empty", { workspaceId: "" }],
    ["projectId empty string", { projectId: "" }],
    ["projectId non-string, non-null", { projectId: 5 as unknown as string }],
  ])("malformed binding supplied to the builder (%s) -> null", (_label, args) => {
    expect(build({}, args as Partial<Parameters<typeof toTeamVideoVerificationSummary>[0]>)).toBeNull();
  });

  it("does NOT reuse the detail mapper's fallbacks for a wholly empty row", () => {
    expect(toTeamVideoVerificationSummary({ verificationId: "vid-1", data: {}, workspaceId: W, projectId: null, project: null })).toBeNull();
  });
});

describe("never emits private fields", () => {
  it("omits userId, userEmail, totalTokens, metadata and modelResults", () => {
    const serialized = JSON.stringify(build());
    for (const forbidden of ["userId", "userEmail", "totalTokens", "metadata", "modelResults", "supportRatio", "warnings"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("teamVideoTimestampIso", () => {
  it("converts a seconds/nanoseconds pair without Date.parse", () => {
    expect(teamVideoTimestampIso({ seconds: 1_700_000_000, nanoseconds: 500_000_000 })).toBe("2023-11-14T22:13:20.500Z");
  });

  it.each([[null], [undefined], ["2023-01-01"], [42], [{ seconds: 1 }], [{ seconds: 1.5, nanoseconds: 0 }]])("rejects %p", (value) => {
    expect(teamVideoTimestampIso(value)).toBeNull();
  });
});
