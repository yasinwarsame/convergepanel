/**
 * Phase 7B — the Projects shell. Deliberately minimal: a heading and one
 * supporting line, no data fetching, no mutation controls, no dead
 * buttons. `GET /api/user/projects` / `GET /api/user/project-runs` are
 * not called here — that's a later Phase 7 increment. This is a plain
 * server component (no "use client", no hooks) because it renders no
 * dynamic state.
 *
 * Structure/spacing anticipates future Active/Unfiled/Archived sections
 * without rendering any of them yet — each is added when its own data
 * integration lands, not stubbed out here as empty placeholders (an
 * empty "You have no Projects" state would be a lie about data this
 * phase never loaded).
 */

export default function ProjectsShell() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="text-2xl font-semibold text-cp-text">Projects</h1>
      <p className="mt-2 text-sm text-cp-muted">Organize your Workspace research into projects.</p>
    </main>
  );
}
