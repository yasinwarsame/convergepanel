/**
 * C-a shared modules (plan §1.4 G-3, register I-7): the corrected D-4 gate `executionIdentityVerified` and the single
 * D-5 placeholder-literal list. N-D4′ (a)–(d) at the gate; MU-mock; the I-7 single-import test.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import {
  executionIdentityVerified,
  identityRowFromFacts,
  placeholderClass,
  runExecutionIdentity,
  STORED_PLACEHOLDER_LITERALS,
  modelWrittenBlockLabel,
  modelWrittenShortLabel,
  rendersAsIndependent,
  runSlotStatement,
  withPlaceholderFact,
} from "@/lib/panel/executionIdentity";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import { rowsRecordExecutionIdentity, storedRunConsensusIndependence } from "@/lib/panel/independentVoices";
import { SETS, rowsOf, referenceK, UV_SETS, BI35_SETS, DIGIT_NEXT_TO_INDEPENDENT, mock, ok, sub, type SetName } from "./executionIdentityScenarios";

describe("corrected D-4 gate: every scenario's kind, K and M", () => {
  it.each(Object.keys(SETS) as SetName[])("%s", (name) => {
    const id = runExecutionIdentity(rowsOf(name));
    expect([name, id.kind, id.independentModels, id.answeredSlots]).toEqual([name, SETS[name].kind, SETS[name].K, SETS[name].M]);
    expect(id.verified).toBe(SETS[name].K !== null);
  });
});

describe("N-D4′", () => {
  it.each(UV_SETS)("(a) %s: unverified, no K, wording without a digit next to 'independent'", (name) => {
    const id = runExecutionIdentity(rowsOf(name));
    expect(id.verified).toBe(false);
    expect(id.independentModels).toBeNull();
    for (const text of [modelWrittenBlockLabel(id), modelWrittenShortLabel(id), runSlotStatement(id)]) {
      expect(text).toMatch(/model independence unverified/);
      expect(text).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
    }
  });

  it("(b) K never comes from requested / dispatched slots: unanswered requested slots change neither K nor the UV verdict", () => {
    for (const name of ["S2", "S1", "S3mn", "PRE62A_OK"] as SetName[]) {
      const base = runExecutionIdentity(rowsOf(name));
      const padded = runExecutionIdentity([...rowsOf(name), { modelId: "gemini", status: "failed", rawText: null } as any, { modelId: "perplexity", status: "timeout" } as any]);
      expect([name, padded.independentModels, padded.verified]).toEqual([name, base.independentModels, base.verified]);
    }
  });

  it.each(["S3mn", "S3mnRecorded", "PRE62A_SUB", "PRE62A_OK", "R_UV", "UNKNOWN_PROVIDER"] as SetName[])(
    "(c) %s: the identity-only gate (b894828 helpers) would verify it; the corrected gate does not",
    (name) => {
      const rows = rowsOf(name);
      expect(rowsRecordExecutionIdentity(rows)).toBe(true);
      expect(storedRunConsensusIndependence({ runDocument: { perModel: rows.map((r: any) => ({ ...r, rawTextTruncated: r.rawText })) } })).not.toBe("unverified");
      expect(executionIdentityVerified(rows)).toBe(false);
    }
  );

  it.each(Object.keys(SETS) as SetName[])("(d) %s: displayed K equals the test-side reference (no resolveExecutingModelKeys)", (name) => {
    expect(runExecutionIdentity(rowsOf(name)).independentModels).toBe(referenceK(rowsOf(name)));
  });

  it("(d) a mixed recorded + unrecorded substitute is never merged into the recorded one (no inferred identity)", () => {
    const rows = [sub("chatgpt"), sub("claude", null), ok("grok")];
    expect(runExecutionIdentity(rows).independentModels).toBeNull();
  });

  it("IND without substitution keeps a clean identity (renders as before)", () => {
    for (const name of BI35_SETS) expect([name, runExecutionIdentity(rowsOf(name)).qualified]).toEqual([name, false]);
  });
});

describe("D-5 closed placeholder list (E19 / E20 / J02)", () => {
  it.each(Object.entries(STORED_PLACEHOLDER_LITERALS))("%s literal → INVALID_MOCK on a fresh row and a persisted (rawTextTruncated) row", (slot, literal) => {
    expect(placeholderClass({ modelId: slot, status: "ok", rawText: literal })).toBe("INVALID_MOCK");
    expect(placeholderClass({ modelId: slot, status: "ok", rawTextTruncated: `  ${literal}\n` })).toBe("INVALID_MOCK");
  });

  it("near misses are not placeholders: another slot's literal, a non-ok status, a quoted phrase (→ VALIDITY_UNKNOWN), plain text", () => {
    expect(placeholderClass({ modelId: "grok", status: "ok", rawText: STORED_PLACEHOLDER_LITERALS.chatgpt })).toBe("VALIDITY_UNKNOWN");
    expect(placeholderClass({ modelId: "claude", status: "ok", rawText: STORED_PLACEHOLDER_LITERALS.chatgpt })).toBe("VALIDITY_UNKNOWN");
    expect(placeholderClass({ modelId: "chatgpt", status: "substituted", rawText: STORED_PLACEHOLDER_LITERALS.chatgpt })).toBe("VALIDITY_UNKNOWN");
    expect(placeholderClass({ modelId: "chatgpt", status: "ok", rawText: "A model answer that quotes 'mock response' in prose." })).toBe("VALIDITY_UNKNOWN");
    expect(placeholderClass({ modelId: "chatgpt", status: "ok", rawText: "Paris." })).toBeNull();
  });

  it("MU-mock: S9u (a phrase, not a listed literal) is NOT excluded as INVALID_MOCK — it makes the run unverified", () => {
    const id = runExecutionIdentity(rowsOf("S9u"));
    expect(id.placeholderSlots).toEqual([]);
    expect(id.kind).toBe("UV");
  });

  it("S9: the two listed placeholders are excluded from K and M; the run is qualified (never presented as clean IND)", () => {
    const id = runExecutionIdentity(rowsOf("S9"));
    expect(id.placeholderSlots).toEqual(["chatgpt", "claude"]);
    expect([id.independentModels, id.answeredSlots, id.qualified]).toEqual([3, 3, true]);
  });

  it("I-7: the literal list exists in exactly one source module, which every consumer imports", () => {
    const roots = ["lib", "components", "app", "hooks"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name === "__fixtures__") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    roots.forEach((r) => walk(join(process.cwd(), r)));
    const holders = files.filter((f) => /Mock response from (chatgpt|claude) \(no API key configured\)/.test(readFileSync(f, "utf8"))).map((f) => relative(process.cwd(), f));
    expect(holders).toEqual(["lib/panel/executionIdentity.ts"]);
    expect(files.some((f) => relative(process.cwd(), f) === "lib/panel/storedMockRow.ts")).toBe(false);
    const importers = files.filter((f) => /from "@\/lib\/panel\/executionIdentity"/.test(readFileSync(f, "utf8"))).map((f) => relative(process.cwd(), f)).sort();
    expect(importers).toEqual(expect.arrayContaining(["components/PanelSynthesisView.tsx", "components/ResultsDisplay.tsx", "components/adaptive/shared.tsx"]));
    // C-a review F-1: the adaptive verdict surfaces import the gate from here (no second copy of the rule).
    expect(importers).toContain("lib/adaptiveSchema/verdictIndependence.ts");
    expect(readFileSync(join(process.cwd(), "lib/adaptiveSchema/verdictIndependence.ts"), "utf8")).not.toMatch(/function (executionIdentityVerified|recordedProvider|isUsable)\b/);
  });
});

describe("C-a review F-1 / F-2: the facts adapter (identityRowFromFacts) reads the same gate over per-slot provenance facts", () => {
  const facts = (rows: readonly unknown[]) => rows.map((r: any) => withPlaceholderFact(runModelProvenanceFromResultRow(r), r));

  it.each(Object.keys(SETS).filter((n) => n !== "S6") as SetName[])("%s: the gate over the facts rows agrees with the gate over the result rows", (name) => {
    const rows = rowsOf(name);
    expect([name, executionIdentityVerified(facts(rows).map(identityRowFromFacts))]).toEqual([name, executionIdentityVerified(rows)]);
    const viaFacts = runExecutionIdentity(facts(rows).map(identityRowFromFacts));
    const viaRows = runExecutionIdentity(rows);
    expect([name, viaFacts.kind, viaFacts.independentModels, viaFacts.placeholderSlots]).toEqual([name, viaRows.kind, viaRows.independentModels, viaRows.placeholderSlots]);
  });

  it("reads only the recorded status, passes provider and the D-5 facts through, and completes nothing (Order 29 A2: `substituted` is never read as a status)", () => {
    expect(identityRowFromFacts({ modelId: "chatgpt", status: "ok", substituted: false, provider: "openai" })).toEqual({ modelId: "chatgpt", status: "ok", provider: "openai" });
    expect(identityRowFromFacts({ modelId: "claude", status: "substituted", substituted: true, provider: "deepseek" })).toEqual({ modelId: "claude", status: "substituted", provider: "deepseek" });
    expect(identityRowFromFacts({ modelId: "gemini", status: "timeout", substituted: false })).toEqual({ modelId: "gemini", status: "timeout" });
    expect(identityRowFromFacts({ modelId: "grok" })).toEqual({ modelId: "grok" });
    // A frozen version-1 export entry (substituted recorded, no outcome): no status — the gate then fails closed.
    expect(identityRowFromFacts({ modelId: "chatgpt", substituted: false, provider: "openai" })).toEqual({ modelId: "chatgpt", provider: "openai" });
    expect(identityRowFromFacts({ modelId: "claude", substituted: true, provider: "deepseek" })).toEqual({ modelId: "claude", provider: "deepseek" });
    expect(identityRowFromFacts({ modelId: "chatgpt", status: "", substituted: false, provider: "openai" })).toEqual({ modelId: "chatgpt", provider: "openai" });
    expect(identityRowFromFacts({ modelId: "chatgpt", status: "ok", substituted: false, provider: "openai", invalidProviderOutput: true })).toEqual({ modelId: "chatgpt", status: "ok", provider: "openai", invalidProviderOutput: true });
    expect(identityRowFromFacts({ modelId: "chatgpt", status: "ok", substituted: false, provider: "openai", validityUnknown: true })).toEqual({ modelId: "chatgpt", status: "ok", provider: "openai", validityUnknown: true });
    expect(identityRowFromFacts(null)).toEqual({});
  });

  it("the D-5 facts are read back as the recorded class; a facts row without them has no class (it holds no text)", () => {
    expect(placeholderClass(identityRowFromFacts(withPlaceholderFact({ modelId: "chatgpt", status: "ok", substituted: false }, mock("chatgpt") as any)))).toBe("INVALID_MOCK");
    expect(placeholderClass(identityRowFromFacts(withPlaceholderFact({ modelId: "chatgpt", status: "ok", substituted: false }, { ...ok("chatgpt"), rawText: "a mock response in prose" } as any)))).toBe("VALIDITY_UNKNOWN");
    expect(placeholderClass(identityRowFromFacts({ modelId: "chatgpt", status: "ok", substituted: false, provider: "openai" }))).toBeNull();
    // Only the literal `true` is a fact.
    expect(placeholderClass({ modelId: "chatgpt", status: "ok", invalidProviderOutput: "true" })).toBeNull();
    expect(placeholderClass({ modelId: "chatgpt", status: "ok", validityUnknown: 1 })).toBeNull();
  });

  it("a facts row with no recorded status, no provider, or provider 'unknown' fails the gate (nothing is inferred)", () => {
    const verified = [{ modelId: "chatgpt", status: "ok", substituted: false, provider: "openai" }, { modelId: "claude", status: "substituted", substituted: true, provider: "deepseek" }];
    expect(executionIdentityVerified(verified.map(identityRowFromFacts))).toBe(true);
    expect(executionIdentityVerified([{ modelId: "chatgpt", status: "ok", substituted: false }, verified[1]].map(identityRowFromFacts))).toBe(false);
    expect(executionIdentityVerified([{ modelId: "chatgpt", provider: "openai" }, verified[1]].map(identityRowFromFacts))).toBe(false);
    expect(executionIdentityVerified([verified[0], { modelId: "claude", status: "substituted", substituted: true, provider: "unknown" }].map(identityRowFromFacts))).toBe(false);
    expect(executionIdentityVerified([verified[0], { modelId: "claude", status: "substituted", substituted: true }].map(identityRowFromFacts))).toBe(false);
    // Version-1 export facts (substituted, provider, no status): unverified — never upgraded by the provider's presence.
    expect(executionIdentityVerified([{ modelId: "chatgpt", substituted: false, provider: "openai" }, { modelId: "claude", substituted: true, provider: "deepseek" }].map(identityRowFromFacts))).toBe(false);
    // Mixed: one recorded row beside one version-1 row → unverified, never upgraded.
    expect(executionIdentityVerified([verified[0], { modelId: "claude", substituted: true, provider: "deepseek" }].map(identityRowFromFacts))).toBe(false);
    // A recorded failure needs no provider and does not make the run unverified; a recorded failure alone (K = 0) is not a verified run.
    expect(executionIdentityVerified([...verified, { modelId: "gemini", status: "timeout" }].map(identityRowFromFacts))).toBe(true);
    expect(runExecutionIdentity([...verified, { modelId: "gemini", status: "timeout" }].map(identityRowFromFacts))).toMatchObject({ kind: "IND", verified: true, independentModels: 2, answeredSlots: 2, panelSlots: 3 });
    expect(executionIdentityVerified([{ modelId: "gemini", status: "timeout" }].map(identityRowFromFacts))).toBe(false);
  });
});

describe("Order 29 finding K=0 → IND: a row set with no answered row is never a verified independent run", () => {
  const failedRows = (statuses: string[]) => statuses.map((status, i) => ({ modelId: ["chatgpt", "claude", "grok", "perplexity", "gemini"][i], status, rawText: null, latencyMs: 1 }));
  it.each([
    ["every slot failed", ["failed", "failed", "failed"]],
    ["every slot timed out / refused / rate-limited / errored", ["timeout", "refused", "rate_limited", "error"]],
    ["one failed slot", ["failed"]],
  ])("%s: the gate fails, kind UV, no K, qualified, not rendered as independent", (_label, statuses) => {
    const rows = failedRows(statuses);
    expect(rowsRecordExecutionIdentity(rows)).toBe(true);
    expect(executionIdentityVerified(rows)).toBe(false);
    const id = runExecutionIdentity(rows);
    expect(id).toEqual({ kind: "UV", verified: false, independentModels: null, answeredSlots: 0, panelSlots: statuses.length, placeholderSlots: [], slotKeys: {}, qualified: true });
    expect(rendersAsIndependent(id)).toBe(false);
    for (const text of [runSlotStatement(id), modelWrittenBlockLabel(id), modelWrittenShortLabel(id)]) {
      expect(text).toMatch(/model independence unverified/);
      expect(text).not.toMatch(/\b0 independent/);
    }
  });
  it("every answered row a stored placeholder (K = 0 once set aside): the gate fails too", () => {
    expect(executionIdentityVerified([mock("chatgpt"), mock("claude")])).toBe(false);
    expect(runExecutionIdentity([mock("chatgpt"), mock("claude"), { modelId: "grok", status: "failed", rawText: null }])).toMatchObject({ kind: "UV", verified: false, independentModels: null, answeredSlots: 0, placeholderSlots: ["chatgpt", "claude"] });
  });
  it("one answered row with a recorded provider is enough: K = 1 stays a verified (FC / IND) run", () => {
    expect(runExecutionIdentity([ok("chatgpt"), ...failedRows(["failed", "timeout"]).map((r, i) => ({ ...r, modelId: ["claude", "grok"][i] }))])).toMatchObject({ kind: "IND", verified: true, independentModels: 1, answeredSlots: 1, panelSlots: 3 });
  });
});
