/**
 * Adaptive Research Export, Phase 3 — server-side DOCX byte generation.
 * Same contract as the PDF renderer (`lib/pdf/renderAdaptiveResearchPdf.ts`):
 * a pure function of the frozen `AdaptiveResearchExportV1` snapshot, no
 * run/Firestore lookups, no network calls, no remote fonts/images.
 *
 * DETERMINISM (Part 10 — read before assuming this behaves like the PDF
 * path): unlike `@react-pdf/renderer`, which exposed a `creationDate` prop
 * that fixed the one non-deterministic field it had, the `docx` library
 * (v9.7.1) gives no public option to override two internal, hardcoded
 * sources of per-render non-determinism, confirmed by reading its
 * (un-exported) implementation directly:
 *
 * 1. `CoreProperties`'s `dcterms:created`/`dcterms:modified` timestamps
 *    (docx/dist/index.cjs `TimestampElement`) are built with
 *    `new Date()` unconditionally — no `created`/`modified` field exists
 *    on the public `IPropertiesOptions` type this composer's `Document(...)`
 *    call can set.
 * 2. Every internal `zip.file(...)` call the `Packer` makes omits an
 *    explicit `date` option, so JSZip's own default
 *    (`s.date = s.date || new Date()`) stamps EVERY archive entry's local
 *    file header — `word/document.xml`, `[Content_Types].xml`, every
 *    part — with the render-time clock, at the ZIP-container level, fully
 *    independent of anything `docx`'s own public API exposes.
 *
 * Both are internal to the library's `Packer`/`CoreProperties` classes,
 * not parameters this module can pass through. Patching them would mean
 * monkey-patching third-party internals (globally overriding `Date`
 * during the call, or reaching into un-exported classes) — exactly the
 * "fragile rewriting of third-party ZIP internals" this phase's own
 * instructions say not to do. **Byte-identical regeneration is therefore
 * NOT claimed for DOCX**, unlike PDF.
 *
 * What IS guaranteed instead — SEMANTIC/PACKAGE-LEVEL determinism: this
 * composer never uses `Hyperlink`/`ExternalHyperlink`/`Bookmark` (the
 * library's other source of per-render randomness, via `nanoid()`-based
 * relationship IDs), so the actual document CONTENT — every heading,
 * paragraph, table cell, governance label, and provenance field inside
 * `word/document.xml` — is a pure, deterministic function of the record.
 * Verified directly (see `lib/docx/__tests__/renderAdaptiveResearchDocx.spec.ts`):
 * unzip two independent renders of the identical frozen record and diff
 * `word/document.xml` byte-for-byte — that inner file IS identical across
 * renders; only the OUTER ZIP container's per-entry timestamps and
 * `docProps/core.xml`'s created/modified fields vary. A downstream
 * integrity check that cares about "did the visible content change" (a
 * content hash of `word/document.xml`, not the whole .docx) is fully
 * reliable; a raw whole-file sha256 of the returned `.docx` is not, and
 * this module's own `sha256` field should be read with that in mind —
 * it is still useful for basic tamper/corruption detection of a single
 * response, just not as a "did regeneration reproduce export A" proof the
 * way the PDF path's sha256 is.
 */

import "server-only";
import { Packer } from "docx";
import { createHash } from "crypto";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { buildAdaptiveResearchDocxDocument } from "./AdaptiveResearchDocxDocument";

export interface RenderedAdaptiveDocx {
  bytes: Buffer;
  sha256: string;
}

export async function renderAdaptiveResearchDocxV1(record: AdaptiveResearchExportV1): Promise<RenderedAdaptiveDocx> {
  const doc = buildAdaptiveResearchDocxDocument(record);
  const bytes = await Packer.toBuffer(doc);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}
