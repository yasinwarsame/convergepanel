import { normalizeSourceUrls } from "@/lib/adaptiveSchema/sourceUrlNormalization";

describe("normalizeSourceUrls", () => {
  it("preserves valid http/https URLs", () => {
    expect(normalizeSourceUrls(["https://example.com/a", "http://example.org/b"])).toEqual([
      { url: "https://example.com/a", hostname: "example.com" },
      { url: "http://example.org/b", hostname: "example.org" },
    ]);
  });

  it("drops plain-text labels that are not URLs at all", () => {
    expect(normalizeSourceUrls(["NIST glossary", "peer-reviewed source"])).toEqual([]);
  });

  it("preserves URLs while dropping interspersed plain labels, in original order", () => {
    expect(normalizeSourceUrls(["NIST glossary", "https://example.com/a", "some label", "https://example.com/b"])).toEqual([
      { url: "https://example.com/a", hostname: "example.com" },
      { url: "https://example.com/b", hostname: "example.com" },
    ]);
  });

  it("rejects non-http(s) schemes: javascript:, data:, file:, ftp:", () => {
    expect(
      normalizeSourceUrls(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "ftp://example.com/f"])
    ).toEqual([]);
  });

  it("trims whitespace before parsing", () => {
    expect(normalizeSourceUrls(["   https://example.com/a   "])).toEqual([{ url: "https://example.com/a", hostname: "example.com" }]);
  });

  it("drops empty and whitespace-only entries", () => {
    expect(normalizeSourceUrls(["", "   ", "\n\t"])).toEqual([]);
  });

  it("deduplicates identical normalized URLs, keeping first-seen order", () => {
    expect(normalizeSourceUrls(["https://example.com/a", "https://example.com/b", "https://example.com/a"])).toEqual([
      { url: "https://example.com/a", hostname: "example.com" },
      { url: "https://example.com/b", hostname: "example.com" },
    ]);
  });

  it("caps the result at 10 entries", () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://example.com/${i}`);
    const result = normalizeSourceUrls(many);
    expect(result).toHaveLength(10);
    expect(result[0]).toEqual({ url: "https://example.com/0", hostname: "example.com" });
    expect(result[9]).toEqual({ url: "https://example.com/9", hostname: "example.com" });
  });

  it("returns an empty array for an empty input list", () => {
    expect(normalizeSourceUrls([])).toEqual([]);
  });

  it("never fetches, scrapes, or invents a title — output is only url/hostname", () => {
    const result = normalizeSourceUrls(["https://example.com/deep/path?query=1"]);
    expect(Object.keys(result[0]).sort()).toEqual(["hostname", "url"]);
  });
});
