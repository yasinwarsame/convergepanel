/**
 * Export Generator Provenance — exportGeneratedBy.ts tests.
 */

const userDocs = new Map<string, Record<string, unknown>>();
const shouldThrow = { value: false };
const firestoreUnavailable = { value: false };

function docSnap(uid: string) {
  return { exists: userDocs.has(uid), data: () => userDocs.get(uid) };
}

const mockAdminDb: any = {
  collection: () => ({
    doc: (uid: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (shouldThrow.value) throw new Error("boom");
        return docSnap(uid);
      }),
    }),
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailable.value ? null : mockAdminDb;
  },
}));

import { resolveExportGeneratedBy, EXPORT_GENERATED_BY_NEUTRAL_FALLBACK } from "@/lib/adaptiveSchema/exportGeneratedBy";

beforeEach(() => {
  userDocs.clear();
  shouldThrow.value = false;
  firestoreUnavailable.value = false;
});

describe("resolveExportGeneratedBy — identity capture", () => {
  it("authenticated exporter with both name and email: display name + masked email", async () => {
    userDocs.set("u1", { name: "Yasin Warsame", email: "yasinwarsame@gmail.com" });
    const result = await resolveExportGeneratedBy("u1");
    expect(result).toEqual({ displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" });
  });

  it("missing display name: falls back to masked email as the displayName too", async () => {
    userDocs.set("u2", { email: "mike@company.com" });
    const result = await resolveExportGeneratedBy("u2");
    expect(result).toEqual({ displayName: "mi***@company.com", maskedEmail: "mi***@company.com" });
  });

  it("missing email: display name only, maskedEmail is null (no fabricated email line)", async () => {
    userDocs.set("u3", { name: "Jane Analyst" });
    const result = await resolveExportGeneratedBy("u3");
    expect(result).toEqual({ displayName: "Jane Analyst", maskedEmail: null });
  });

  it("no identity at all (name and email both absent): safe neutral fallback, never a raw uid", async () => {
    userDocs.set("u4", {});
    const result = await resolveExportGeneratedBy("u4");
    expect(result).toEqual({ displayName: EXPORT_GENERATED_BY_NEUTRAL_FALLBACK, maskedEmail: null });
    expect(result.displayName).not.toContain("u4");
  });

  it("user document does not exist at all: safe neutral fallback, never throws", async () => {
    const result = await resolveExportGeneratedBy("nonexistent-uid");
    expect(result).toEqual({ displayName: EXPORT_GENERATED_BY_NEUTRAL_FALLBACK, maskedEmail: null });
  });

  it("Firestore read throws: degrades to neutral fallback, never propagates the error", async () => {
    shouldThrow.value = true;
    const result = await resolveExportGeneratedBy("u1");
    expect(result).toEqual({ displayName: EXPORT_GENERATED_BY_NEUTRAL_FALLBACK, maskedEmail: null });
  });

  it("Firestore unavailable (adminDb null): degrades to neutral fallback, never throws", async () => {
    firestoreUnavailable.value = true;
    const result = await resolveExportGeneratedBy("u1");
    expect(result).toEqual({ displayName: EXPORT_GENERATED_BY_NEUTRAL_FALLBACK, maskedEmail: null });
  });
});

describe("resolveExportGeneratedBy — privacy", () => {
  it("never returns the raw uid anywhere in the result", async () => {
    userDocs.set("u1", { name: "Yasin Warsame", email: "yasinwarsame@gmail.com" });
    const result = await resolveExportGeneratedBy("u1");
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("u1");
  });

  it("never returns the full unmasked email", async () => {
    userDocs.set("u1", { name: "Yasin Warsame", email: "yasinwarsame@gmail.com" });
    const result = await resolveExportGeneratedBy("u1");
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("yasinwarsame@gmail.com");
  });

  it("malformed name/email fields (non-string) are treated as absent, never crash", async () => {
    userDocs.set("u1", { name: 12345, email: { nested: "object" } });
    const result = await resolveExportGeneratedBy("u1");
    expect(result).toEqual({ displayName: EXPORT_GENERATED_BY_NEUTRAL_FALLBACK, maskedEmail: null });
  });
});
