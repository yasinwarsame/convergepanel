/**
 * Phase 5E — pre-global noindex hardening. `/workspace` is a private,
 * authenticated application route with no reason to be indexed: the
 * anonymous/ineligible path only gets `noindex` incidentally, via Next's
 * built-in default not-found page — this segment-level metadata is what
 * makes the real, authenticated Workspace shell explicitly non-indexable
 * too, regardless of which branch `page.tsx` ends up rendering.
 */

import { metadata } from "@/app/workspace/layout";

describe("Workspace layout — private-route metadata", () => {
  it("explicitly opts the segment out of indexing and following", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
