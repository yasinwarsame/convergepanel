/**
 * Error-contract drift detection (agreed with the #325 docs agent).
 *
 * fixtures/api-1a-errors.snapshot.json is generated from lib/apiPlatform/errors.ts at the commit it names
 * (`commit`, a full SHA). This spec asserts API_ERRORS deep-equals the snapshot's `codes`, so ANY change to an
 * error code, status, type or message must regenerate the snapshot in the same change (and is then visible in
 * review). The #325 docs carry an identical copy at docs/product/api-0/implementation-snapshots/api-1a-errors.json,
 * checked there against the error catalog.
 *
 * RESTACK TASK (after #325 merges and #327 is rebased onto it): add an assertion here that the two copies are
 * byte-identical, so the docs catalog and the code cannot drift apart.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { API_ERRORS } from "@/lib/apiPlatform/errors";

const FIXTURE = path.join(__dirname, "fixtures/api-1a-errors.snapshot.json");
const raw = readFileSync(FIXTURE, "utf8");
const snapshot = JSON.parse(raw) as {
  source: string;
  pr: number;
  commit: string;
  codes: Record<string, { status: number; type: string; message: string }>;
};

describe("API-1a error snapshot", () => {
  it("has exactly the agreed envelope: source, pr, commit (full SHA), codes", () => {
    expect(Object.keys(snapshot)).toEqual(["source", "pr", "commit", "codes"]);
    expect(snapshot.source).toBe("lib/apiPlatform/errors.ts");
    expect(snapshot.pr).toBe(327);
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("codes are sorted, and each entry has exactly status, type, message", () => {
    const keys = Object.keys(snapshot.codes);
    expect(keys).toEqual([...keys].sort());
    for (const k of keys) expect([k, Object.keys(snapshot.codes[k])]).toEqual([k, ["status", "type", "message"]]);
  });

  it("API_ERRORS deep-equals the snapshot codes (regenerate the snapshot with any errors.ts change)", () => {
    const live: Record<string, { status: number; type: string; message: string }> = {};
    for (const k of Object.keys(API_ERRORS).sort()) {
      const e = API_ERRORS[k as keyof typeof API_ERRORS];
      live[k] = { status: e.status, type: e.type, message: e.message };
    }
    expect(live).toStrictEqual(snapshot.codes);
  });

  it("is canonical JSON (2-space indent, trailing newline) so the docs copy can be compared byte for byte", () => {
    expect(raw).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
  });
});
