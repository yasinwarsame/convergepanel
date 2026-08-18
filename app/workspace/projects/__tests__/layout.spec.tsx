/**
 * Phase 7B — pre-launch noindex hardening. `/workspace/projects` is a
 * private, authenticated application route with no reason to be indexed.
 * Mirrors app/workspace/__tests__/layout.spec.tsx exactly.
 */

import { metadata } from "@/app/workspace/projects/layout";

describe("Projects layout — private-route metadata", () => {
  it("explicitly opts the segment out of indexing and following", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
