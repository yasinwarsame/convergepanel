/**
 * Saved-response and comparison presentation (2026-11-11): ModelResponsesSection's comparison table keeps every cell —
 * repeated positions and cells without a subject or attribute are shown, never dropped — and the legacy schemas keep
 * their original markup.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
import { createElement } from "react";
import TestRenderer from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import ModelResponsesSection from "@/components/adaptive/ModelResponsesSection";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";

const schema = getResultSchema("comparison_matrix" as never);
const text = (n: TestRenderer.ReactTestInstance): string => n.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const result = (cells: unknown[]): AdaptiveModelResult => ({ modelId: "chatgpt", schemaId: "comparison_matrix", ok: true, data: { cells } } as AdaptiveModelResult);

describe("comparison table", () => {
  it("a repeated position shows every entry; an empty position says so; unpaired cells are listed", () => {
    const r = TestRenderer.create(
      createElement(ModelResponsesSection, {
        schema,
        results: [
          result([
            { subject: "A", attribute: "x", value: "one", verdict: "better" },
            { subject: "A", attribute: "x", value: "two", verdict: "worse" },
            { subject: "B", attribute: "y", value: "three" },
            { subject: "", attribute: "x", value: "orphan", verdict: "even" },
          ]),
        ],
      })
    );
    const table = r.root.findByType("table");
    const rows = table.findAllByType("tr").map((tr) => tr.findAll((n) => n.type === "th" || n.type === "td").map(text));
    expect(rows).toEqual([
      ["Compared", "x", "y"],
      ["A", "one (Better)two (Worse)Listed 2 times by this model", "Not assessed"],
      ["B", "Not assessed", "three"],
    ]);
    const unpaired = r.root.findAll((n) => n.type === "li" && text(n).includes("orphan"));
    expect(unpaired.map(text)).toEqual(["x: orphan (Even)"]);
  });

  it("no dangerouslySetInnerHTML anywhere in the section's output path", () => {
    const html = renderToStaticMarkup(createElement(ModelResponsesSection, { schema, results: [result([{ subject: "<i>s</i>", attribute: "a", value: "v" }])] }));
    expect(html).toContain("&lt;i&gt;s&lt;/i&gt;");
  });

  it("a legacy schema keeps the original heading and list markup", () => {
    const generic = getResultSchema("generic" as never);
    const html = renderToStaticMarkup(
      createElement(ModelResponsesSection, { schema: generic, results: [{ modelId: "chatgpt", schemaId: "generic", ok: true, data: { summary: "S" } } as AdaptiveModelResult] })
    );
    expect(html).toContain("Raw model output (1)");
    expect(html).not.toContain("model-response-counts");
  });
});
