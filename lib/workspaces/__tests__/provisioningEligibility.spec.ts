/**
 * Existing-User Personal Workspace Provisioning, Phase 2B —
 * classifyUserEligibility() / parseExclusionList() / validateExclusionUids()
 * / readExclusionFile() / loadExclusionSet() tests.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  classifyUserEligibility,
  loadExclusionSet,
  parseExclusionList,
  readExclusionFile,
  validateExclusionUids,
} from "@/lib/workspaces/provisioningEligibility";

describe("classifyUserEligibility", () => {
  it("grants a normal, enabled, non-excluded user", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ eligible: true });
  });

  it("excludes a disabled Auth user", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: true }, new Set());
    expect(result).toEqual({ eligible: false, reason: "excluded_disabled" });
  });

  it("excludes a uid present in the operator-supplied exclusion set", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: false }, new Set(["uid-1"]));
    expect(result).toEqual({ eligible: false, reason: "excluded_explicit" });
  });

  it("disabled takes precedence when a uid is both disabled AND explicitly excluded", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: true }, new Set(["uid-1"]));
    expect(result).toEqual({ eligible: false, reason: "excluded_disabled" });
  });

  it("does not exclude a uid absent from the exclusion set", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: false }, new Set(["uid-2", "uid-3"]));
    expect(result).toEqual({ eligible: true });
  });
});

describe("parseExclusionList", () => {
  it("parses one uid per line", () => {
    expect(parseExclusionList("uid-1\nuid-2\nuid-3")).toEqual(new Set(["uid-1", "uid-2", "uid-3"]));
  });

  it("ignores blank lines", () => {
    expect(parseExclusionList("uid-1\n\n\nuid-2\n")).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("ignores comment lines starting with #", () => {
    expect(parseExclusionList("# service accounts\nuid-1\n# more\nuid-2")).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("trims whitespace around each uid", () => {
    expect(parseExclusionList("  uid-1  \n\tuid-2\t")).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("returns an empty set for empty input", () => {
    expect(parseExclusionList("")).toEqual(new Set());
  });

  it("handles CRLF line endings — a trailing \\r is stripped the same as any other trailing whitespace", () => {
    expect(parseExclusionList("uid-1\r\nuid-2\r\n# comment\r\nuid-3\r\n")).toEqual(new Set(["uid-1", "uid-2", "uid-3"]));
  });

  it("strips a leading UTF-8 BOM from the very first entry", () => {
    expect(parseExclusionList("\uFEFFuid-1\nuid-2")).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("handles a trailing newline without producing a phantom empty entry", () => {
    const result = parseExclusionList("uid-1\nuid-2\n");
    expect(result).toEqual(new Set(["uid-1", "uid-2"]));
    expect(result.has("")).toBe(false);
  });

  it("deduplicates repeated uids into a single Set entry, deterministically", () => {
    const result = parseExclusionList("uid-1\nuid-2\nuid-1\nuid-2\nuid-1");
    expect(result).toEqual(new Set(["uid-1", "uid-2"]));
    expect(result.size).toBe(2);
  });
});

describe("validateExclusionUids", () => {
  it("passes for a set of well-formed uids", () => {
    expect(validateExclusionUids(new Set(["uid-1", "abc123", "test-user-9"]))).toEqual({ ok: true });
  });

  it("passes for an empty set", () => {
    expect(validateExclusionUids(new Set())).toEqual({ ok: true });
  });

  it("rejects a uid containing a path separator, reusing the same validator getPersonalWorkspaceId uses", () => {
    const result = validateExclusionUids(new Set(["uid-1", "not/a/uid"]));
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "malformed_exclusion_uid", invalidUids: ["not/a/uid"] }));
  });

  it("rejects an empty-string entry", () => {
    const result = validateExclusionUids(new Set([""]));
    expect(result.ok).toBe(false);
  });

  it("rejects '.' and '..' (reserved Firestore segments)", () => {
    const result = validateExclusionUids(new Set([".", ".."]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.invalidUids.sort()).toEqual([".", ".."]);
  });

  it("collects every invalid entry, not just the first", () => {
    const result = validateExclusionUids(new Set(["good-uid", "bad/one", "bad/two"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.invalidUids.sort()).toEqual(["bad/one", "bad/two"]);
  });
});

describe("readExclusionFile / loadExclusionSet — real filesystem behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-exclusion-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a well-formed exclusion file", () => {
    const filePath = path.join(tmpDir, "exclude.txt");
    fs.writeFileSync(filePath, "uid-1\nuid-2\n");
    expect(readExclusionFile(filePath)).toBe("uid-1\nuid-2\n");
  });

  it("throws a clear error (not a raw ENOENT stack trace) when the file does not exist", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.txt");
    expect(() => readExclusionFile(missingPath)).toThrow(/Could not read exclusion file/);
  });

  it("throws a clear error when the file exists but is unreadable (permission denied)", () => {
    const filePath = path.join(tmpDir, "unreadable.txt");
    fs.writeFileSync(filePath, "uid-1\n");
    fs.chmodSync(filePath, 0o000);
    try {
      // Running as root (common in CI/sandboxed containers) bypasses unix
      // permission bits entirely — skip the assertion in that specific
      // case rather than produce a flaky failure unrelated to this code.
      if (process.getuid && process.getuid() === 0) {
        return;
      }
      expect(() => readExclusionFile(filePath)).toThrow(/Could not read exclusion file/);
    } finally {
      fs.chmodSync(filePath, 0o644); // restore so afterEach's rmSync can clean up
    }
  });

  it("loadExclusionSet combines CLI uids and file uids into one deduplicated set", () => {
    const filePath = path.join(tmpDir, "exclude.txt");
    fs.writeFileSync(filePath, "uid-2\nuid-3\n");
    const result = loadExclusionSet(["uid-1", "uid-2"], filePath);
    expect(result).toEqual(new Set(["uid-1", "uid-2", "uid-3"]));
  });

  it("loadExclusionSet with no file path returns just the CLI uids", () => {
    expect(loadExclusionSet(["uid-1", "uid-2"], undefined)).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("loadExclusionSet propagates (never swallows) a missing exclude-file — must never silently fall back to zero file-based exclusions", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.txt");
    expect(() => loadExclusionSet(["uid-1"], missingPath)).toThrow(/Could not read exclusion file/);
  });
});
