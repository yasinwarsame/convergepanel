# S-E.2 export PDF goldens, one file per runtime

PDF bytes depend on the runtime. Node's bundled zlib and the renderer packages both change them, while text and layout stay the same. Each file pins the PDF hashes for one runtime, keyed by `fingerprintId`.

The fingerprint id is built from zlib, arch, TZ, the @react-pdf packages, fontkit, yoga-layout, docx, jszip and the standard-font data hash. Every file records the full fingerprint: Node version, platform and OS release.

- **`base`:** every fixture, rendered by the unchanged-main renderer at `0249a4e5`, using the vendored base files.
- **`versionOne`:** every new Decision Support export, rendered by the code under review.
- **Capture:** run `captureGolden.mjs`, which refuses to capture unless HEAD reproduced unchanged main in that same run.

| fingerprintId | Runtime | Captured in |
|---|---|---|
| `1b18e34ab428be92` | macOS x64, Node 26.6.0, zlib 1.2.12 | Developer machine, shared `node_modules` (`pdfjs-dist` 6.0.227, which is read-only text extraction and doesn't affect bytes). Its `base` hashes equal the 413e14b evidence (`../historicalBaseline.json`). Not authoritative for CI. |
| `b11c55b308450031` | Node 24.22.1, zlib 1.3.2.1-motley, x64 | Authoritative: clean `npm ci` from the committed lockfile, the CI Node version. See the file for platform and OS details. |
