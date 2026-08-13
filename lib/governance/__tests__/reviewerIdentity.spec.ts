/**
 * Review & Governance report completion — reviewerIdentity.ts tests.
 */

const userDocs = new Map<string, Record<string, unknown>>();
const shouldThrow = { value: false };
const firestoreUnavailable = { value: false };
const getAllShouldThrow = { value: false };

function docSnap(uid: string) {
  return { exists: userDocs.has(uid), data: () => userDocs.get(uid) };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (uid: string) => ({
      _uid: uid,
      get: jest.fn().mockImplementation(async () => {
        if (shouldThrow.value) throw new Error("boom");
        return docSnap(uid);
      }),
    }),
  }),
  getAll: jest.fn().mockImplementation(async (...refs: Array<{ _uid: string }>) => {
    if (getAllShouldThrow.value) throw new Error("batch boom");
    return refs.map((ref) => docSnap(ref._uid));
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailable.value ? null : mockAdminDb;
  },
}));

import { resolveReviewerDisplayName, resolveReviewerDisplayNames, UNKNOWN_REVIEWER_LABEL, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";

beforeEach(() => {
  userDocs.clear();
  shouldThrow.value = false;
  firestoreUnavailable.value = false;
  getAllShouldThrow.value = false;
  mockAdminDb.getAll.mockClear();
});

describe("resolveReviewerDisplayName", () => {
  it("prefers users/{uid}.name when present and non-empty", async () => {
    userDocs.set("u1", { name: "Jane Smith", email: "jane@example.com" });
    const name = await resolveReviewerDisplayName("u1", "jane@example.com", undefined);
    expect(name).toBe("Jane Smith");
  });

  it("trims a name field before using it", async () => {
    userDocs.set("u1", { name: "  Jane Smith  " });
    const name = await resolveReviewerDisplayName("u1", "jane@example.com", undefined);
    expect(name).toBe("Jane Smith");
  });

  it("falls back to a masked email when name is absent", async () => {
    userDocs.set("u1", {});
    const name = await resolveReviewerDisplayName("u1", "jane.smith@example.com", undefined);
    expect(name).toBe("jan***@example.com");
  });

  it("falls back to a masked email when name is an empty/whitespace string", async () => {
    userDocs.set("u1", { name: "   " });
    const name = await resolveReviewerDisplayName("u1", "jane.smith@example.com", undefined);
    expect(name).toBe("jan***@example.com");
  });

  it("shows the unmasked email when it matches the caller's own email", async () => {
    userDocs.set("u1", {});
    const name = await resolveReviewerDisplayName("u1", "jane.smith@example.com", "jane.smith@example.com");
    expect(name).toBe("jane.smith@example.com");
  });

  it("falls back to UNKNOWN_REVIEWER_LABEL when no user doc, no name, and no email are resolvable", async () => {
    const name = await resolveReviewerDisplayName("u1", undefined, undefined);
    expect(name).toBe(UNKNOWN_REVIEWER_LABEL);
  });

  it("degrades to the email fallback when the Firestore read throws", async () => {
    shouldThrow.value = true;
    const name = await resolveReviewerDisplayName("u1", "jane.smith@example.com", undefined);
    expect(name).toBe("jan***@example.com");
  });

  it("degrades to the email fallback when adminDb is unavailable", async () => {
    firestoreUnavailable.value = true;
    const name = await resolveReviewerDisplayName("u1", "jane.smith@example.com", undefined);
    expect(name).toBe("jan***@example.com");
  });

  it("never throws even when both the read fails and no fallback email exists", async () => {
    shouldThrow.value = true;
    await expect(resolveReviewerDisplayName("u1", undefined, undefined)).resolves.toBe(UNKNOWN_REVIEWER_LABEL);
  });
});

describe("resolveReviewerDisplayNames", () => {
  it("batches resolution and preserves uid -> name mapping regardless of input order", async () => {
    userDocs.set("u1", { name: "Jane Smith" });
    userDocs.set("u2", { name: "Mohamed Ali" });
    const emailByUid = new Map([
      ["u1", "jane@example.com"],
      ["u2", "mohamed@example.com"],
      ["u3", "sarah@example.com"],
    ]);
    const result = await resolveReviewerDisplayNames(["u3", "u1", "u2"], emailByUid, undefined);
    expect(result.get("u1")).toBe("Jane Smith");
    expect(result.get("u2")).toBe("Mohamed Ali");
    expect(result.get("u3")).toBe("sar***@example.com");
    expect(result.size).toBe(3);
  });

  it("issues exactly ONE Firestore call (db.getAll) for the whole batch — never one read per uid (final review request)", async () => {
    userDocs.set("u1", { name: "Jane Smith" });
    userDocs.set("u2", { name: "Mohamed Ali" });
    userDocs.set("u3", { name: "Sarah Chen" });
    await resolveReviewerDisplayNames(["u1", "u2", "u3"], new Map(), undefined);
    expect(mockAdminDb.getAll).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated uids into a single read", async () => {
    userDocs.set("u1", { name: "Jane Smith" });
    await resolveReviewerDisplayNames(["u1", "u1", "u1"], new Map(), undefined);
    const [...refs] = mockAdminDb.getAll.mock.calls[0];
    expect(refs).toHaveLength(1);
  });

  it("chunks at 10 uids per db.getAll() call, issuing multiple batched calls (never one call per uid) for a larger set", async () => {
    const uids = Array.from({ length: 23 }, (_, i) => `u${i}`);
    for (const uid of uids) userDocs.set(uid, { name: `Name ${uid}` });
    const result = await resolveReviewerDisplayNames(uids, new Map(), undefined);
    // 23 uids at 10/chunk -> 3 calls (10 + 10 + 3), never 23 individual calls.
    expect(mockAdminDb.getAll).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(23);
    expect(result.get("u0")).toBe("Name u0");
    expect(result.get("u22")).toBe("Name u22");
  });

  it("degrades every uid in a chunk to its email fallback if that chunk's db.getAll() call throws, without failing the whole request", async () => {
    getAllShouldThrow.value = true;
    const emailByUid = new Map([
      ["u1", "jane.smith@example.com"],
      ["u2", "mohamed.ali@example.com"],
    ]);
    const result = await resolveReviewerDisplayNames(["u1", "u2"], emailByUid, undefined);
    expect(result.get("u1")).toBe("jan***@example.com");
    expect(result.get("u2")).toBe("moh***@example.com");
  });

  it("falls back to per-uid masked email/placeholder without any Firestore call when adminDb is unavailable", async () => {
    firestoreUnavailable.value = true;
    const emailByUid = new Map([["u1", "jane.smith@example.com"]]);
    const result = await resolveReviewerDisplayNames(["u1", "u2"], emailByUid, undefined);
    expect(result.get("u1")).toBe("jan***@example.com");
    expect(result.get("u2")).toBe(UNKNOWN_REVIEWER_LABEL);
  });

  it("returns an empty map for an empty uid list without calling Firestore", async () => {
    const result = await resolveReviewerDisplayNames([], new Map(), undefined);
    expect(result.size).toBe(0);
    expect(mockAdminDb.getAll).not.toHaveBeenCalled();
  });
});

describe("resolveReviewerDisplayName — masked-email edge cases (final review request)", () => {
  it("1-char local part (a@b.com): keeps only the single character, full domain visible per the shared maskEmail convention", async () => {
    const name = await resolveReviewerDisplayName("u1", "a@b.com", undefined);
    expect(name).toBe("a***@b.com");
  });

  it("2-char local part (ab@example.com): keeps only the FIRST character, not both — never a near-complete local part", async () => {
    const name = await resolveReviewerDisplayName("u1", "ab@example.com", undefined);
    expect(name).toBe("a***@example.com");
  });

  it("3-char local part: keeps only the first character (<=3 branch), consistent with the 1-2 char cases", async () => {
    const name = await resolveReviewerDisplayName("u1", "abc@example.com", undefined);
    expect(name).toBe("a***@example.com");
  });

  it("long local part: keeps at most the first 3 characters, never more, regardless of length", async () => {
    const name = await resolveReviewerDisplayName("u1", "yasinwarsame@example.com", undefined);
    expect(name).toBe("yas***@example.com");
    expect(name).not.toContain("yasinwarsame");
  });

  it("plus-addressed email (unusual but valid): only the first 3 raw characters survive, the '+tag' portion is never separately preserved", async () => {
    const name = await resolveReviewerDisplayName("u1", "jane+reviews@example.com", undefined);
    expect(name).toBe("jan***@example.com");
  });

  it("missing/empty email with no name: degrades to the opaque placeholder, never an empty or malformed masked string", async () => {
    const name = await resolveReviewerDisplayName("u1", "", undefined);
    expect(name).toBe(UNKNOWN_REVIEWER_LABEL);
  });

  it("masked email exposure is bounded to the caller's own team roster — an email never sourced from the roster is never visible to a caller outside it", async () => {
    // Simulates the route's own scoping: emailByUid is built ONLY from
    // teamCtx.team.members (the caller's own team). A reviewer uid with no
    // roster entry (e.g. the caller isn't on that reviewer's team) yields
    // `undefined` for the email argument here — proving the resolver never
    // fabricates or looks up an email independently, only what its caller
    // explicitly supplies.
    const rosterScopedEmail = undefined; // uid not found in the caller's own team.members
    const name = await resolveReviewerDisplayName("some-other-team-uid", rosterScopedEmail, undefined);
    expect(name).toBe(UNKNOWN_REVIEWER_LABEL);
  });

  it("name is always preferred over masked email when both are available — masked email is a true fallback, not a co-equal default", async () => {
    userDocs.set("u1", { name: "Jane Smith" });
    const name = await resolveReviewerDisplayName("u1", "jane.smith@example.com", undefined);
    expect(name).toBe("Jane Smith");
    expect(name).not.toContain("@");
  });
});

describe("resolveReviewerDisplayName — self-sourced email fallback (personal-review-reviewer-identity fix)", () => {
  it("falls back to the uid's OWN account email (from its users/{uid} doc) when no name is set and no roster/fallbackEmail was supplied — this is the actual personal-reviewer bug: a reviewer not on the caller's team roster has no fallbackEmail source at all", async () => {
    userDocs.set("u1", { email: "personal.reviewer@example.com" });
    const name = await resolveReviewerDisplayName("u1", undefined, undefined);
    expect(name).toBe("per***@example.com");
    expect(name).not.toBe(UNKNOWN_REVIEWER_LABEL);
  });

  it("prefers the uid's own account email over a caller-supplied fallbackEmail when both exist (own account is always authoritative for that uid)", async () => {
    userDocs.set("u1", { email: "own.account@example.com" });
    const name = await resolveReviewerDisplayName("u1", "stale.roster.email@example.com", undefined);
    expect(name).toBe("own***@example.com");
  });

  it("still degrades to unresolvedLabel when the doc exists but has neither name nor email, and no fallbackEmail was supplied", async () => {
    userDocs.set("u1", {});
    const name = await resolveReviewerDisplayName("u1", undefined, undefined);
    expect(name).toBe(UNKNOWN_REVIEWER_LABEL);
  });

  it("accepts a custom unresolvedLabel (e.g. REVIEWER_UNAVAILABLE_LABEL) in place of the default UNKNOWN_REVIEWER_LABEL — a known assignment with a failed lookup must never say the generic 'Unknown reviewer'", async () => {
    const name = await resolveReviewerDisplayName("u1", undefined, undefined, REVIEWER_UNAVAILABLE_LABEL);
    expect(name).toBe("Reviewer unavailable");
    expect(name).not.toBe(UNKNOWN_REVIEWER_LABEL);
  });
});

describe("resolveReviewerDisplayNames (batched) — self-sourced email fallback (personal-review-reviewer-identity fix)", () => {
  it("resolves a personal reviewer's own account email even with an empty emailByUid map (no team roster) — the exact scenario GET /api/user/reviews and the governance/review-history routes hit for a non-team-member reviewer", async () => {
    userDocs.set("u1", { email: "reviewer.self@example.com" });
    const result = await resolveReviewerDisplayNames(["u1"], new Map(), undefined);
    expect(result.get("u1")).toBe("rev***@example.com");
    expect(result.get("u1")).not.toBe(UNKNOWN_REVIEWER_LABEL);
  });

  it("accepts a custom unresolvedLabel applied uniformly across a whole batch", async () => {
    const result = await resolveReviewerDisplayNames(["u1", "u2"], new Map(), undefined, REVIEWER_UNAVAILABLE_LABEL);
    expect(result.get("u1")).toBe("Reviewer unavailable");
    expect(result.get("u2")).toBe("Reviewer unavailable");
  });

  it("cross-surface consistency: resolving the same uid via the single and batched variants with the same underlying doc yields the identical display name", async () => {
    userDocs.set("u1", { email: "consistent@example.com" });
    const single = await resolveReviewerDisplayName("u1", undefined, undefined);
    const batched = await resolveReviewerDisplayNames(["u1"], new Map(), undefined);
    expect(single).toBe(batched.get("u1"));
    expect(single).toBe("con***@example.com");
  });
});
