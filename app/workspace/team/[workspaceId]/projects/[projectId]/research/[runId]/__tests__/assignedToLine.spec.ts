/**
 * Project/Research Assignment (D9) — the Team run detail page renders a
 * READ-ONLY "Assigned to" line from the SAME authorized read
 * (`getTeamWorkspaceRun()`), after every gate, with the stale marker, and
 * carries NO assignment editor and NO assignee route call. Source-level
 * pin (Server Component; no jsdom).
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

it("renders 'Assigned to' from run.assignee with the stale marker, after the run read succeeded", () => {
  const readIdx = source.indexOf("await getTeamWorkspaceRun(");
  const lineIdx = source.indexOf("Assigned to");
  expect(readIdx).toBeGreaterThan(-1);
  expect(lineIdx).toBeGreaterThan(readIdx);
  expect(source).toMatch(/run\.assignee !== null/);
  expect(source).toMatch(/run\.assignee\.displayName/);
  expect(source).toMatch(/run\.assignee\.state === "stale"/);
  expect(source).toMatch(/No longer eligible/);
});

it("D9 — no editor on the detail page: no RunAssigneeDialog / ProjectAssigneesDialog / useTeamRunAssignee import, and no assignee route fetch", () => {
  expect(source).not.toMatch(/RunAssigneeDialog|ProjectAssigneesDialog|useTeamRunAssignee|\/assignee`|\/assignees`/);
  expect(source).not.toMatch(/assigneeUid/);
});
