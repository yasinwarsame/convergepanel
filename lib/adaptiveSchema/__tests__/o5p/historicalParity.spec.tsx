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
import { stripAnalysisNoticeHtml } from "@/components/adaptive/__tests__/analysisNoticeStrip";

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

/**
 * Executing-model attribution (owner rule, connector fail-closed pass, 2026-11-05): a slot the run records as
 * substituted is named by the model that wrote it, "DeepSeek (substituting Claude)", never as the requested model. The
 * 2c17feee oracle predates that rule, so for a scenario whose rows record a substitution the outputs that name that
 * slot are pinned EXACTLY here instead — full sha-256 of the rendered output (any dropped, duplicated or reverted label
 * changes it) plus, per output key, the exact count of the executing label and of executing-model chips (neutral dot +
 * label) — captured on this branch at the commit that
 * introduced the file (see its `capturedAt`). Every other output of that scenario, and every output of every scenario
 * with no recorded substitution, is still held to the untouched 2c17feee oracle. No output is transformed before hashing.
 */
type AttributionPins = {
  capturedAt: string;
  label: string;
  /** A chip naming the executing model: the neutral dot (never the requested model's identity colour), then the label. */
  chipMarkup: string;
  scenarios: Record<string, { hashes: Record<string, Record<string, string>>; labelCounts: Record<string, number>; executingChipCounts: Record<string, number> }>;
};
const ATTRIBUTION: AttributionPins = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "executing-attribution", "renderHashes.json"), "utf8"));
const hasRecordedSubstitution = (rows: any[]) => rows.some((r) => r && r.status === "substituted");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

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
    // D-3 (2026-11-02): the owner-approved analysis-availability notice is removed before hashing against the 2c17feee
    // oracle, and required exactly where the record's synthesis is degraded (the narrative-failure scenario) and nowhere else.
    let notices = 0;
    const labelCounts: Record<string, number> = {};
    const chipCounts: Record<string, number> = {};
    const actual = Object.fromEntries(
      Object.entries(outputs).map(([k, v]) => {
        if (v === null) return [k, null];
        const stripped = stripAnalysisNoticeHtml(v);
        // Review MINOR-5: never more than one notice in one rendered output.
        expect([name, k, stripped.count <= 1]).toEqual([name, k, true]);
        notices += stripped.count;
        labelCounts[k] = occurrences(stripped.markup, ATTRIBUTION.label);
        chipCounts[k] = occurrences(stripped.markup, ATTRIBUTION.chipMarkup + ATTRIBUTION.label);
        return [k, sha(stripped.markup)];
      })
    );
    expect([name, notices > 0]).toEqual([name, records[name]?.synthesisReport?.degraded === true]);
    expect(renderHashes).toBeDefined();
    const pins = ATTRIBUTION.scenarios[name];
    // Pinned exactly where (and only where) the run records a substitution.
    expect([name, pins !== undefined]).toEqual([name, hasRecordedSubstitution(scenario.results() as any[])]);
    if (!pins) {
      // No recorded substitution: the untouched 2c17feee oracle, every output, and the executing label nowhere.
      expect(actual).toEqual(renderHashes![name]);
      expect(Object.values(labelCounts).every((n) => n === 0)).toBe(true);
      return;
    }
    // Exact executing-label and executing-chip counts per output key (every key, zeros included).
    expect(labelCounts).toEqual(pins.labelCounts);
    expect(chipCounts).toEqual(pins.executingChipCounts);
    const pinnedForTimezone = pins.hashes[ORACLE_TIMEZONE];
    expect(pinnedForTimezone).toBeDefined();
    // Outputs that name the substituted slot: the exact pinned rendering. Every other output: the 2c17feee oracle.
    expect(Object.keys(pinnedForTimezone).sort()).toEqual(Object.keys(labelCounts).filter((k) => labelCounts[k] > 0).sort());
    for (const k of Object.keys(pinnedForTimezone)) expect([k, pinnedForTimezone[k] !== renderHashes![name][k]]).toEqual([k, true]);
    expect(actual).toEqual({ ...renderHashes![name], ...pinnedForTimezone });
  });

  it.each(Object.keys(SHARED_MEMO_INPUTS))("shared memo generator: %s is byte-identical", (key) => {
    expect(normalizeMemo(generateVerificationMemo(JSON.parse(JSON.stringify(SHARED_MEMO_INPUTS[key]))))).toBe(sharedMemos[key]);
  });
});
