/**
 * #290 Increment 1 — shared fixtures and render helpers for the readable-layout specs (not a spec itself).
 *
 * Records are the Order 5 o5p historical records (lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee),
 * read only — never written. Each scenario's slot rows come from o5pScenarios.ts, the same rows the records were built
 * from, so RunSlotStatusContext carries the real recorded slot statuses.
 *
 * remoteWorkFixture(): the #290 "remote work productivity" shape — generic schema, 4 of 5 slots responded (one
 * failed), gate fail, degraded synthesis. No saved Production run was read (standing rule: no test records in
 * Production). Built from the "generic-substituted-and-failed" record, whose rows already have 4 responding slots
 * (one substituted) and grok failed. Fields edited, and nothing else:
 *   - gate.status: "caution" → "fail"
 *   - synthesisReport.gate: "caution" → "fail"
 *   - synthesisReport.degraded: false → true
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { RunSlotStatusContext } from "@/components/adaptive/RunSlotStatusContext";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import { SCENARIOS } from "@/lib/adaptiveSchema/__tests__/o5p/o5pScenarios";
import type { ModelResult } from "@/lib/types";

export const QUESTION = "Does remote work change productivity?";

const RECORDS: Record<string, any> = JSON.parse(
  readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/records.json"), "utf8")
);

export const PILOT_SCENARIOS = ["generic-mixed", "generic-mixed-narrative-fail", "generic-consensus", "generic-splits", "generic-substituted-and-failed", "generic-all-failed", "contested-empirical", "medical-health", "legal-regulatory", "financial-valuation", "procedural", "forecast", "creative"];
export const ALL_SCENARIOS = SCENARIOS.map((s) => s.name);

export function record(name: string): any {
  if (!(name in RECORDS)) throw new Error(`no record ${name}`);
  return JSON.parse(JSON.stringify(RECORDS[name]));
}

export function slotRows(name: string): ModelResult[] {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s.results();
}

export function remoteWorkFixture(): { rec: any; rows: ModelResult[] } {
  const rec = record("generic-substituted-and-failed");
  rec.gate.status = "fail";
  rec.synthesisReport.gate = "fail";
  rec.synthesisReport.degraded = true;
  return { rec, rows: slotRows("generic-substituted-and-failed") };
}

export function panelElement(rec: any, rows: ModelResult[] | null, extra: Record<string, unknown> = {}): ReactElement {
  const panel = createElement(AdaptivePanelResponse as any, {
    schema: getResultSchema(rec.schemaId),
    classification: rec.classification,
    results: rec.results,
    alignedClaims: rec.alignedClaims,
    gate: rec.gate,
    synthesisReport: rec.synthesisReport,
    trustSummary: rec.trustSummary,
    question: QUESTION,
    runId: "run-290",
    ...extra,
  });
  if (!rows) return panel;
  return createElement(
    RunModelProvenanceContext.Provider,
    { value: rows.map((r) => runModelProvenanceFromResultRow(r as any)) },
    createElement(RunSlotStatusContext.Provider, { value: new Map(rows.map((r) => [r.modelId, String(r.status ?? "")])) }, panel)
  );
}

export function renderPanel(rec: any, rows: ModelResult[] | null, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(panelElement(rec, rows, extra));
}

/** Visible text of an HTML string (tags removed, entities for quotes/ampersands decoded, whitespace collapsed). */
export function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** The outer HTML of the first element carrying data-readable-tier="<tier>" (balanced on its own tag name). */
export function tierHtml(html: string, tier: string): string | null {
  const start = html.indexOf(`data-readable-tier="${tier}"`);
  if (start < 0) return null;
  const open = html.lastIndexOf("<", start);
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(open))![1];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "gi");
  re.lastIndex = open;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  throw new Error(`unbalanced ${tier}`);
}
