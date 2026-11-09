/**
 * C-a test helper: render an adaptive surface under exactly the contexts ResultsDisplay provides for a run's rows
 * (provenance facts with the D-5 placeholder fact, slot statuses, and the corrected-gate execution identity).
 * `identity: "none"` renders without the identity context (a surface not handed the run's rows — the pre-C-a output).
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { RunSlotStatusContext } from "@/components/adaptive/RunSlotStatusContext";
import { RunExecutionIdentityContext } from "@/components/adaptive/RunExecutionIdentityContext";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import { runExecutionIdentity, withPlaceholderFact } from "@/lib/panel/executionIdentity";
import type { ModelResult } from "@/lib/types";

export function renderUnderRun(el: ReactElement, rows: readonly ModelResult[], identity: "rows" | "none" = "rows"): string {
  const facts = rows.map((r) => withPlaceholderFact(runModelProvenanceFromResultRow(r as any), r as any));
  const statuses = new Map(rows.map((r) => [r.modelId, String(r.status ?? "")]));
  const inner = createElement(RunSlotStatusContext.Provider, { value: statuses }, el);
  const withIdentity = identity === "rows" ? createElement(RunExecutionIdentityContext.Provider, { value: runExecutionIdentity(rows) }, inner) : inner;
  return renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: facts }, withIdentity));
}

/** Markup → visible text, tags as separators. */
export const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
