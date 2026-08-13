import { maskEmailForExportProvenance } from "@/lib/utils/maskEmailForExportProvenance";

describe("maskEmailForExportProvenance", () => {
  it("reveals the first 2 local-part characters for a long local part", () => {
    expect(maskEmailForExportProvenance("yasinwarsame@gmail.com")).toBe("ya***@gmail.com");
    expect(maskEmailForExportProvenance("mike@company.com")).toBe("mi***@company.com");
  });

  it("reveals the whole local part when it has exactly 2 characters", () => {
    expect(maskEmailForExportProvenance("ab@example.com")).toBe("ab***@example.com");
  });

  it("reveals the whole local part when it has exactly 1 character", () => {
    expect(maskEmailForExportProvenance("a@example.com")).toBe("a***@example.com");
  });

  it("reveals exactly 2 characters for a 3-character local part (not the whole thing)", () => {
    expect(maskEmailForExportProvenance("abc@example.com")).toBe("ab***@example.com");
  });

  it("always preserves the full domain", () => {
    expect(maskEmailForExportProvenance("x@a-very-long-subdomain.example.co.uk")).toBe("x***@a-very-long-subdomain.example.co.uk");
  });

  it("handles plus-addressing as ordinary local-part characters, never strips or special-cases the +suffix", () => {
    expect(maskEmailForExportProvenance("yasin+exports@gmail.com")).toBe("ya***@gmail.com");
  });

  it("preserves case rather than normalizing it", () => {
    expect(maskEmailForExportProvenance("YasinWarsame@Gmail.com")).toBe("Ya***@Gmail.com");
  });

  it("trims surrounding whitespace", () => {
    expect(maskEmailForExportProvenance("  mike@company.com  ")).toBe("mi***@company.com");
  });

  it("returns null, never throws, for missing input", () => {
    expect(maskEmailForExportProvenance(null)).toBeNull();
    expect(maskEmailForExportProvenance(undefined)).toBeNull();
    expect(maskEmailForExportProvenance("")).toBeNull();
    expect(maskEmailForExportProvenance("   ")).toBeNull();
  });

  it("returns null, never throws, for malformed email-shaped input", () => {
    expect(maskEmailForExportProvenance("not-an-email")).toBeNull();
    expect(maskEmailForExportProvenance("@example.com")).toBeNull(); // no local part
    expect(maskEmailForExportProvenance("mike@")).toBeNull(); // no domain
    expect(maskEmailForExportProvenance("justtext")).toBeNull();
  });

  it("never reveals more than the domain-preserving masked form — full unmasked address never appears in output", () => {
    const result = maskEmailForExportProvenance("yasinwarsame@gmail.com");
    expect(result).not.toContain("yasinwarsame");
    expect(result).not.toBe("yasinwarsame@gmail.com");
  });
});
