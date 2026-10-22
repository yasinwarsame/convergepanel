/**
 * Order 5 Contract P — historical parity. Every record here was produced by the shipped 2c17feee builder (so it carries
 * no presentation.disagreementPositionVersion marker, exactly like a historical record) and rendered through every
 * supported consumer at 2c17feee; the hashes in __fixtures__/baseline-2c17fee were captured there, before any Contract P
 * change, and are never regenerated from this branch. An unmarked record must render byte-identically on every surface,
 * and the shared memo generator must produce byte-identical claim / video / legacy-research memos.
 *
 * Timezone (PR #256 CI). The PDF and DOCX exports print the record's timestamps in the process timezone, and assigning
 * process.env.TZ inside a jest test file does not change it (jest gives the test its own copy of process.env). So
 * renderHashes.json, captured at 2c17feee before any Contract P change, holds the capturing machine's timezone
 * (Africa/Nairobi, UTC+3) — kept byte-for-byte. renderHashes.UTC.json holds the same 2c17feee application code and
 * render harness (worktree at 739c110) rendering the same records with TZ=UTC set for the process, as CI runs; it
 * differs from renderHashes.json only in export.pdfTree and export.docxXml. Neither is generated from this branch.
 * The oracle is chosen by the effective timezone; any other timezone fails: run with TZ=UTC.
 */

jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { SCENARIOS } from "./o5pScenarios";
import { SHARED_MEMO_INPUTS, normalizeMemo, renderRecord } from "./o5pRender";

const FIXTURES = join(__dirname, "__fixtures__", "baseline-2c17fee");
const records: Record<string, any> = JSON.parse(readFileSync(join(FIXTURES, "records.json"), "utf8"));
type Hashes = Record<string, Record<string, string | null>>;
const readHashes = (file: string): Hashes => JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
const ORACLE_BY_TIMEZONE: Record<string, Hashes> = { "Africa/Nairobi": readHashes("renderHashes.json"), UTC: readHashes("renderHashes.UTC.json") };
const UTC_NAMES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Universal", "Etc/Zulu", "Zulu"]);
const EFFECTIVE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ORACLE_TIMEZONE = UTC_NAMES.has(EFFECTIVE_TIMEZONE) ? "UTC" : EFFECTIVE_TIMEZONE;
const renderHashes: Hashes | undefined = ORACLE_BY_TIMEZONE[ORACLE_TIMEZONE];
const TIMEZONE_KEYS = ["export.docxXml", "export.pdfTree"];
const sharedMemos: Record<string, string> = JSON.parse(readFileSync(join(FIXTURES, "sharedMemos.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("Contract P historical parity (2c17feee oracles)", () => {
  it("runs in a timezone a 2c17feee oracle was captured in (run with TZ=UTC)", () => {
    expect([EFFECTIVE_TIMEZONE, renderHashes !== undefined]).toEqual([EFFECTIVE_TIMEZONE, true]);
  });

  it("the two oracles agree on every output except the two that print a timestamp, and differ on those", () => {
    const nairobi = ORACLE_BY_TIMEZONE["Africa/Nairobi"];
    const utc = ORACLE_BY_TIMEZONE.UTC;
    expect(Object.keys(utc).sort()).toEqual(Object.keys(nairobi).sort());
    for (const name of Object.keys(nairobi)) {
      expect([name, Object.keys(utc[name]).sort()]).toEqual([name, Object.keys(nairobi[name]).sort()]);
      for (const key of Object.keys(nairobi[name])) {
        if (TIMEZONE_KEYS.includes(key) && nairobi[name][key] !== null) expect([name, key, utc[name][key] !== nairobi[name][key]]).toEqual([name, key, true]);
        else expect([name, key, utc[name][key]]).toEqual([name, key, nairobi[name][key]]);
      }
    }
  });

  it("covers every fixture scenario, and no historical record carries the marker", () => {
    expect(Object.keys(records).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
    for (const rec of Object.values(records)) expect(JSON.stringify(rec)).not.toContain("disagreementPositionVersion");
  });

  it.each(SCENARIOS.map((s) => s.name))("%s: every consumer renders the unmarked record byte-identically", async (name) => {
    const scenario = SCENARIOS.find((s) => s.name === name)!;
    const outputs = await renderRecord(JSON.parse(JSON.stringify(records[name])), scenario.results());
    const actual = Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v === null ? null : sha(v)]));
    expect(renderHashes).toBeDefined();
    expect(actual).toEqual(renderHashes![name]);
  });

  it.each(Object.keys(SHARED_MEMO_INPUTS))("shared memo generator: %s is byte-identical", (key) => {
    expect(normalizeMemo(generateVerificationMemo(JSON.parse(JSON.stringify(SHARED_MEMO_INPUTS[key]))))).toBe(sharedMemos[key]);
  });
});
