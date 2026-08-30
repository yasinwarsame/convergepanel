/**
 * Evidence Workspace, Phase 11A.2a — normalizeEvidenceSourceReferences() tests.
 */

import { normalizeEvidenceSourceReferences } from "@/lib/verification/evidenceSourceExtraction";

describe("normalizeEvidenceSourceReferences — valid sources", () => {
  it("A. normal finding with 1 valid source", () => {
    const result = normalizeEvidenceSourceReferences(["https://example.com/article"]);
    expect(result).toEqual([{ url: "https://example.com/article", hostname: "example.com" }]);
  });

  it("B. normal finding with several valid sources", () => {
    const result = normalizeEvidenceSourceReferences(["https://a.example/1", "https://b.example/2", "http://c.example/3"]);
    expect(result).toEqual([
      { url: "https://a.example/1", hostname: "a.example" },
      { url: "https://b.example/2", hostname: "b.example" },
      { url: "http://c.example/3", hostname: "c.example" },
    ]);
  });
});

describe("normalizeEvidenceSourceReferences — zero / absent / non-array", () => {
  it("D. zero sources -> []", () => {
    expect(normalizeEvidenceSourceReferences([])).toEqual([]);
  });

  it("E. sources field absent (undefined) -> []", () => {
    expect(normalizeEvidenceSourceReferences(undefined)).toEqual([]);
  });

  it("F. sources non-array (object) -> [] (never throws)", () => {
    expect(normalizeEvidenceSourceReferences({ not: "an array" })).toEqual([]);
  });

  it("F2. sources non-array (string) -> []", () => {
    expect(normalizeEvidenceSourceReferences("https://example.com")).toEqual([]);
  });

  it("F3. sources null -> []", () => {
    expect(normalizeEvidenceSourceReferences(null)).toEqual([]);
  });
});

describe("normalizeEvidenceSourceReferences — malformed entries dropped individually", () => {
  it("G. mixed valid/malformed sources retains only the valid ones, in order", () => {
    const result = normalizeEvidenceSourceReferences([
      "https://valid-one.example/a",
      "NIST glossary", // plain label, not a URL
      null,
      undefined,
      42,
      {},
      "",
      "   ",
      "https://valid-two.example/b",
    ]);
    expect(result).toEqual([
      { url: "https://valid-one.example/a", hostname: "valid-one.example" },
      { url: "https://valid-two.example/b", hostname: "valid-two.example" },
    ]);
  });

  it("M. invalid URL string dropped, does not throw", () => {
    expect(normalizeEvidenceSourceReferences(["not a url at all", "https://ok.example/x"])).toEqual([{ url: "https://ok.example/x", hostname: "ok.example" }]);
  });
});

describe("normalizeEvidenceSourceReferences — dangerous schemes rejected", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "ftp://example.com/file", "vbscript:msgbox(1)"])(
    "J. rejects scheme in %s",
    (dangerous) => {
      expect(normalizeEvidenceSourceReferences([dangerous, "https://safe.example/y"])).toEqual([{ url: "https://safe.example/y", hostname: "safe.example" }]);
    }
  );
});

describe("normalizeEvidenceSourceReferences — credential-bearing URLs (stricter than Decision Receipt)", () => {
  it("K. https://user@host/path (username only) is rejected entirely", () => {
    expect(normalizeEvidenceSourceReferences(["https://user@example.com/x", "https://ok.example/y"])).toEqual([{ url: "https://ok.example/y", hostname: "ok.example" }]);
  });

  it("K2. https://user:pass@host/path (username + password) is rejected entirely", () => {
    expect(normalizeEvidenceSourceReferences(["https://user:pass@example.com/x", "https://ok.example/y"])).toEqual([{ url: "https://ok.example/y", hostname: "ok.example" }]);
  });
});

describe("normalizeEvidenceSourceReferences — deduplication", () => {
  it("H. exact duplicate normalized URL deduplicated, first-seen order preserved", () => {
    const result = normalizeEvidenceSourceReferences(["https://example.com/a", "https://example.com/b", "https://example.com/a"]);
    expect(result).toEqual([
      { url: "https://example.com/a", hostname: "example.com" },
      { url: "https://example.com/b", hostname: "example.com" },
    ]);
  });

  it("I. same hostname, different paths remain distinct (never dedup by hostname alone)", () => {
    const result = normalizeEvidenceSourceReferences(["https://example.com/a", "https://example.com/b"]);
    expect(result).toHaveLength(2);
  });

  it("distinct normalized URLs remain distinct even with trivial formatting differences that don't affect URL.toString()", () => {
    // Trailing default port :443 collapses via the URL parser itself, not custom logic.
    const result = normalizeEvidenceSourceReferences(["https://example.com:443/a", "https://example.com/a"]);
    expect(result).toHaveLength(1);
  });
});

describe("normalizeEvidenceSourceReferences — cap", () => {
  it("L. more than 10 valid unique sources -> capped at 10, first-seen order, deterministic", () => {
    const inputs = Array.from({ length: 15 }, (_, i) => `https://example.com/page-${i}`);
    const result = normalizeEvidenceSourceReferences(inputs);
    expect(result).toHaveLength(10);
    expect(result).toEqual(inputs.slice(0, 10).map((url) => ({ url, hostname: "example.com" })));
  });

  it("cap counts only VALID unique entries — malformed entries preceding valid ones don't consume cap slots", () => {
    const inputs = [
      "not a url",
      "javascript:alert(1)",
      ...Array.from({ length: 12 }, (_, i) => `https://example.com/page-${i}`),
    ];
    const result = normalizeEvidenceSourceReferences(inputs);
    expect(result).toHaveLength(10);
    expect(result[0]).toEqual({ url: "https://example.com/page-0", hostname: "example.com" });
  });
});

describe("normalizeEvidenceSourceReferences — URL length bound", () => {
  it("below-bound valid URL is accepted", () => {
    const url = "https://example.com/" + "a".repeat(500);
    expect(normalizeEvidenceSourceReferences([url])).toEqual([{ url, hostname: "example.com" }]);
  });

  it("above-bound URL is rejected, not truncated", () => {
    const url = "https://example.com/" + "a".repeat(3000);
    expect(normalizeEvidenceSourceReferences([url])).toEqual([]);
  });
});

describe("normalizeEvidenceSourceReferences — Unicode / IDN", () => {
  it("Unicode/IDN hostname is accepted and punycode-normalized deterministically via platform URL semantics", () => {
    const result = normalizeEvidenceSourceReferences(["https://例え.テスト/path"]);
    expect(result).toHaveLength(1);
    expect(result[0].hostname).toBe("xn--r8jz45g.xn--zckzah");
  });

  it("Unicode path / percent-encoding round-trips deterministically", () => {
    const result1 = normalizeEvidenceSourceReferences(["https://example.com/héllo"]);
    const result2 = normalizeEvidenceSourceReferences(["https://example.com/héllo"]);
    expect(result1).toEqual(result2);
    expect(result1).toHaveLength(1);
  });
});

describe("normalizeEvidenceSourceReferences — non-vacuity (mutation-testing evidence, documented here for the reader; actual mutation performed manually during implementation and reverted)", () => {
  it("scheme rejection genuinely exercises non-http(s) input, not merely type-checking", () => {
    // If scheme validation were removed, this would return a "javascript:" URL as a source.
    expect(normalizeEvidenceSourceReferences(["javascript:alert(1)"])).toEqual([]);
  });

  it("cap is genuinely enforced against real input, not merely documented", () => {
    const inputs = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`);
    expect(normalizeEvidenceSourceReferences(inputs)).toHaveLength(10);
  });
});
