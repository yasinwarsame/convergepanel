/**
 * Review & Governance report completion — reviewerIdentity.ts tests.
 */

const userDocs = new Map<string, Record<string, unknown>>();
const shouldThrow = { value: false };
const firestoreUnavailable = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (uid: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (shouldThrow.value) throw new Error("boom");
        return { exists: userDocs.has(uid), data: () => userDocs.get(uid) };
      }),
    }),
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailable.value ? null : mockAdminDb;
  },
}));

import { resolveReviewerDisplayName, resolveReviewerDisplayNames, UNKNOWN_REVIEWER_LABEL } from "@/lib/governance/reviewerIdentity";

beforeEach(() => {
  userDocs.clear();
  shouldThrow.value = false;
  firestoreUnavailable.value = false;
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
});
