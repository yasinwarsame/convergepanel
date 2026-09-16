/**
 * Project/Research Assignment (D9) — the Team run detail surface renders a
 * READ-ONLY "Assigned to" line with the stale marker, and carries NO
 * assignment editor and NO assignee route call.
 *
 * TEAM-RESEARCH-PARITY-R3 — the line moved with the run read: the page no
 * longer reads the run, `TeamResearchDetailShell` does (through the R1
 * endpoint), so the line now renders from that authorized response's `team`
 * metadata. Source-level pins on both files; the rendered behaviour (including
 * that a raw uid is never shown) is proven in `TeamResearchDetailShell.spec.tsx`.
 */

import { readFileSync } from "fs";
import { join } from "path";

const page = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
const shell = readFileSync(join(process.cwd(), "components", "workspace", "projects", "TeamResearchDetailShell.tsx"), "utf8");

it("the shell renders 'Assigned to' from the authorized response metadata, with the stale marker, only after the read settled", () => {
  const readIdx = shell.indexOf("interpretTeamRunDetailResponse(body");
  const lineIdx = shell.indexOf("Assigned to");
  expect(readIdx).toBeGreaterThan(-1);
  expect(lineIdx).toBeGreaterThan(-1);
  expect(shell).toMatch(/meta\.assignee !== null/);
  expect(shell).toMatch(/meta\.assignee\.displayName/);
  expect(shell).toMatch(/meta\.assignee\.state === "stale"/);
  expect(shell).toMatch(/No longer eligible/);
  expect(shell).not.toMatch(/meta\.assignee\.uid/);
});

it("D9 — no editor on the detail surface: no RunAssigneeDialog / ProjectAssigneesDialog / useTeamRunAssignee, and no assignee route fetch, in the page or the shell", () => {
  for (const source of [page, shell]) {
    expect(source).not.toMatch(/RunAssigneeDialog|ProjectAssigneesDialog|useTeamRunAssignee|\/assignee`|\/assignees`/);
    expect(source).not.toMatch(/assigneeUid/);
  }
});
