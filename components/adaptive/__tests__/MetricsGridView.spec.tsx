/**
 * MetricsGridView tests. Renders the real component (react-dom/server — no
 * jsdom needed) against AdaptiveModelResult fixtures, matching the
 * structural-check convention used by ComparisonMatrixView.spec.tsx and the
 * other adaptive renderer tests.
 *
 * The "mobile scroll affordance" describe block below mirrors
 * ComparisonMatrixView.spec.tsx's equivalent block as closely as this
 * renderer's actual markup allows (see MetricsGridView.tsx's own comment):
 * no sticky column here (not added — out of scope for a presentation-only
 * polish fix, this table was already contained-scrollable before this
 * change), and the scroll-shadow itself is CSS-only rather than component
 * state, so these tests check the structural contract (the right
 * background-image/attachment properties are present on the scroll
 * container, and the region only renders at all when there's a real table)
 * rather than simulating real scroll/resize events — this repo's adaptive
 * renderer tests never use jsdom, so there is no real layout to measure.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MetricsGridView from "@/components/adaptive/MetricsGridView";
import { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function result(modelId: string, data: Record<string, unknown>): AdaptiveModelResult {
  return { modelId: modelId as ModelId, schemaId: "financial_valuation", ok: true, data: data as any };
}

function metric(overrides: { label: string; value: number | null; unit: string; asOf: string }) {
  return overrides;
}

describe("MetricsGridView", () => {
  it("renders each model's own metric value/unit side by side, never averaged", () => {
    const results = [
      result("chatgpt", { thesis: "x", metrics: [metric({ label: "P/E", value: 18, unit: "x", asOf: "2026" })] }),
      result("claude", { thesis: "x", metrics: [metric({ label: "P/E", value: 22, unit: "x", asOf: "2026" })] }),
    ];
    const html = renderToStaticMarkup(createElement(MetricsGridView, { results } as any));
    expect(html).toMatch(/18/);
    expect(html).toMatch(/22/);
    expect(html).not.toMatch(/\b20\b\s*x/);
  });

  it("shows a dash for a model that didn't report a given metric, rather than inventing a value", () => {
    const results = [
      result("chatgpt", { thesis: "x", metrics: [metric({ label: "P/E", value: 18, unit: "x", asOf: "2026" })] }),
      result("claude", { thesis: "x", metrics: [] }),
    ];
    const html = renderToStaticMarkup(createElement(MetricsGridView, { results } as any));
    expect(html).toMatch(/—/); // em dash placeholder
  });

  describe("mobile scroll affordance (contained horizontal scroll, right-edge CSS shadow)", () => {
    function twoModelResults() {
      return [
        result("chatgpt", { thesis: "x", metrics: [metric({ label: "P/E", value: 18, unit: "x", asOf: "2026" })] }),
        result("claude", { thesis: "x", metrics: [metric({ label: "P/E", value: 22, unit: "x", asOf: "2026" })] }),
      ];
    }

    it("keeps the scroll region contained: overflow-x-auto on the table's own wrapper, not a page-level class", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/class="[^"]*overflow-x-auto[^"]*"[^>]*>\s*<table/);
    });

    it("does not gain any page-level (non-contained) overflow class — the only overflow-x-auto is on the table wrapper", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      const matches = html.match(/overflow-x-auto/g) || [];
      expect(matches.length).toBe(1);
    });

    it("gives the scroll region an accessible label and role", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/role="region"/);
      expect(html).toMatch(/aria-label="Metrics table, scroll horizontally to see all models"/);
    });

    it("makes the scroll region keyboard-reachable via a positive-order tabIndex on the scrollable container", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/);
    });

    it("keeps a visible focus indicator on the scroll region rather than suppressing outline entirely", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/focus-visible:ring/);
    });

    it("marks model headers scope=col and the metric label header scope=row, so header/value association survives horizontal scroll for assistive tech", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/<th scope="col"/);
      expect(html).toMatch(/<th scope="row"/);
    });

    it("shows a narrow-viewport scroll hint that's hidden at desktop widths (md:hidden), not a permanent desktop element", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/md:hidden/);
      expect(html).toMatch(/Scroll to see all models/);
    });

    it("the right-edge scroll shadow (structural contract — no jsdom overflow measurement available): a cover gradient that scrolls WITH the content and a shadow indicator pinned to the viewport edge, present whenever the metrics table renders", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      // background-attachment: local (moves with content) + scroll (pinned
      // to the viewport) is the load-bearing pair that makes this tied to
      // real scroll position rather than an unconditional decoration.
      expect(html).toMatch(/background-attachment:\s*local,\s*scroll/);
      expect(html).toMatch(/radial-gradient/);
      expect(html).toMatch(/linear-gradient/);
    });

    it("the scroll-shadow affordance is absent (no scroll region at all) when there are no metrics to show — never implies scrollable content that doesn't exist", () => {
      const results = [result("chatgpt", { thesis: "x", metrics: [] })];
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results } as any));
      expect(html).not.toMatch(/role="region"/);
      expect(html).not.toMatch(/background-attachment/);
      expect(html).not.toMatch(/Scroll to see all models/);
    });

    it("preserves desktop table structure: a real <table> with <thead>/<tbody>, not stacked cards", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/<table[^>]*class="[^"]*w-full[^"]*"/);
      expect(html).toContain("<thead>");
      expect(html).toContain("<tbody>");
    });

    it("min/max highlighting and cell values still render correctly alongside the new header semantics", () => {
      const html = renderToStaticMarkup(createElement(MetricsGridView, { results: twoModelResults() } as any));
      expect(html).toMatch(/bg-green-50/);
      expect(html).toMatch(/bg-orange-50/);
    });
  });
});
