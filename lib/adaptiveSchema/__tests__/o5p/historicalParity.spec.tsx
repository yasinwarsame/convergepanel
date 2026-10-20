/**
 * Order 5 Contract P — historical parity. Every record here was produced by the shipped 2c17feee builder (so it carries
 * no presentation.disagreementPositionVersion marker, exactly like a historical record) and rendered through every
 * supported consumer at 2c17feee; the hashes in __fixtures__/baseline-2c17fee were captured there, before any Contract P
 * change, and are never regenerated from this branch. An unmarked record must render byte-identically on every surface,
 * and the shared memo generator must produce byte-identical claim / video / legacy-research memos.
 */
process.env.TZ = "UTC";

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
const renderHashes: Record<string, Record<string, string | null>> = JSON.parse(readFileSync(join(FIXTURES, "renderHashes.json"), "utf8"));
const sharedMemos: Record<string, string> = JSON.parse(readFileSync(join(FIXTURES, "sharedMemos.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("Contract P historical parity (2c17feee oracles)", () => {
  it("covers every fixture scenario, and no historical record carries the marker", () => {
    expect(Object.keys(records).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
    for (const rec of Object.values(records)) expect(JSON.stringify(rec)).not.toContain("disagreementPositionVersion");
  });

  it.each(SCENARIOS.map((s) => s.name))("%s: every consumer renders the unmarked record byte-identically", async (name) => {
    const scenario = SCENARIOS.find((s) => s.name === name)!;
    const outputs = await renderRecord(JSON.parse(JSON.stringify(records[name])), scenario.results());
    const actual = Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v === null ? null : sha(v)]));
    expect(actual).toEqual(renderHashes[name]);
  });

  it.each(Object.keys(SHARED_MEMO_INPUTS))("shared memo generator: %s is byte-identical", (key) => {
    expect(normalizeMemo(generateVerificationMemo(JSON.parse(JSON.stringify(SHARED_MEMO_INPUTS[key]))))).toBe(sharedMemos[key]);
  });
});
