# Codebase documentation & comments

## Goals

- **File-level comments** explain *what* a module is for and *who* calls it (API route, UI page, shared lib).
- **Inline comments** belong on non-obvious logic: invariants, security boundaries, Firestore limits, retry reasons, and UX tradeoffs.
- Not every line needs a comment; prefer clear names and small functions.

## Maintenance script

Run from the repo root when you add new modules without headers:

```bash
node scripts/ensure-file-headers.mjs
```

- Scans `lib/`, `app/`, `components/`, `hooks/`, `prisma/`.
- Skips files that already start with a `/*` or `//` comment (after optional `"use client"`).
- Inserts a short block comment; **tighten or replace** auto-generated text for important surfaces (auth, billing, panel runner).

Use `--dry-run` to preview paths that would change.

## Layout reference

| Area | Role |
|------|------|
| `app/` | Next.js App Router: pages, layouts, error boundaries, API `route.ts` handlers. |
| `components/` | Client UI building blocks; heavy pieces may be dynamically imported from pages. |
| `lib/` | Domain logic, connectors, Firestore, verification, synthesis, billing helpers. |
| `hooks/` | Reusable React hooks (`"use client"`). |
| `prisma/` | Database schema and seed script. |
| `scripts/` | Dev verification and one-off maintenance (not shipped to the browser). |

## Policy

- **`lib/codecheck/`** and other vendored/snapshot trees may follow different rules; do not bulk-rewrite without an explicit task.
- Keep comments **accurate**: update or delete them when behavior changes.
