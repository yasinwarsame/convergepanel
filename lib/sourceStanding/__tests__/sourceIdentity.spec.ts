/**
 * Order 4 Slice 2a — SourceIdentityV1: one canonical identity per cited
 * document. Canonicalization, rejection matrix, hash contract.
 */
import { createHash } from "crypto";
import { isSourceIdHash, sourceIdHash, sourceIdentityV1, SOURCE_IDENTITY_VERSION } from "@/lib/sourceStanding/sourceIdentity";

const canon = (raw: unknown) => sourceIdentityV1(raw)?.canonicalUrl ?? null;

describe("SourceIdentityV1 — canonicalization", () => {
  it.each([
    ["https://www.sec.gov/cgi-bin/browse-edgar", "https://www.sec.gov/cgi-bin/browse-edgar"],
    ["  https://www.sec.gov/cgi-bin/browse-edgar  ", "https://www.sec.gov/cgi-bin/browse-edgar"],
    ["https://WWW.SEC.GOV/Path", "https://www.sec.gov/Path"], // host lowercased, path case kept
    ["https://www.sec.gov./x", "https://www.sec.gov/x"], // exactly one trailing dot stripped
    ["https://www.sec.gov/x#frag", "https://www.sec.gov/x"], // fragment dropped
    ["https://www.sec.gov/x?b=2&a=1", "https://www.sec.gov/x?b=2&a=1"], // query kept verbatim (order is identity)
    ["https://www.sec.gov/x?q=1#f", "https://www.sec.gov/x?q=1"],
    ["https://www.sec.gov", "https://www.sec.gov/"],
    ["https://www.sec.gov:443/x", "https://www.sec.gov/x"], // default port elided by WHATWG
    ["https://www.sec.gov:8443/x", "https://www.sec.gov:8443/x"],
    ["http://www.sec.gov/x", "http://www.sec.gov/x"], // scheme is part of identity
    ["https://bücher.example.com/a", "https://xn--bcher-kva.example.com/a"], // punycode host
  ])("%s → %s", (raw, expected) => {
    expect(canon(raw)).toBe(expected);
  });

  it("is idempotent: the canonical URL canonicalizes to itself", () => {
    for (const raw of ["https://WWW.SEC.GOV./x?q=1#f", "https://bücher.example.com/a", "https://www.sec.gov"]) {
      const c = canon(raw) as string;
      expect(canon(c)).toBe(c);
    }
  });

  it("distinct documents never share an identity (query, scheme, path)", () => {
    const ids = ["https://a.example.com/x", "https://a.example.com/x?q=1", "http://a.example.com/x", "https://a.example.com/X"].map((u) => sourceIdentityV1(u)?.idHash);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("SourceIdentityV1 — rejection (no identity, never looked up)", () => {
  it.each([
    ["plain label", "NIST glossary"],
    ["empty", ""],
    ["whitespace", "   "],
    ["userinfo", "https://user:pw@www.cdc.gov/x"],
    ["username only", "https://user@www.cdc.gov/x"],
    ["localhost", "http://localhost/admin"],
    ["single label", "https://intranet/x"],
    ["IPv4", "https://127.0.0.1/x"],
    ["IPv6", "https://[::1]/x"],
    ["reserved suffix .test", "https://foo.test/x"],
    ["reserved suffix .local", "https://printer.local/x"],
    ["two trailing dots", "https://www.sec.gov../x"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,hi"],
    ["ftp:", "ftp://example.com/x"],
    ["over-long", `https://example.com/${"a".repeat(2100)}`],
  ])("%s", (_name, raw) => {
    expect(sourceIdentityV1(raw)).toBeNull();
  });

  it.each([null, undefined, 42, {}, [], ["https://example.com"]])("non-string %p", (raw) => {
    expect(sourceIdentityV1(raw)).toBeNull();
  });
});

describe("SourceIdentityV1 — hash contract", () => {
  it('idHash = lowercase hex sha256("v1:" + canonicalUrl), 64 chars, identityVersion 1', () => {
    const id = sourceIdentityV1("https://www.sec.gov/x#f");
    expect(id).not.toBeNull();
    expect(id!.identityVersion).toBe(SOURCE_IDENTITY_VERSION);
    expect(SOURCE_IDENTITY_VERSION).toBe(1);
    expect(id!.idHash).toBe(createHash("sha256").update("v1:https://www.sec.gov/x", "utf8").digest("hex"));
    expect(id!.idHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceIdHash(id!.canonicalUrl)).toBe(id!.idHash);
    expect(Object.keys(id!)).toEqual(["identityVersion", "canonicalUrl", "idHash"]);
  });

  it("the version prefix is part of the hash (an unprefixed sha256 is not an id)", () => {
    expect(sourceIdHash("https://www.sec.gov/x")).not.toBe(createHash("sha256").update("https://www.sec.gov/x").digest("hex"));
  });

  it("isSourceIdHash accepts only 64 lowercase hex characters", () => {
    expect(isSourceIdHash("a".repeat(64))).toBe(true);
    for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "", null, 1, "__x__"]) expect(isSourceIdHash(bad)).toBe(false);
  });
});
