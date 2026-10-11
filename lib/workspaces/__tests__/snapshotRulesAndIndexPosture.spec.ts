/**
 * ADD-TO-TEAM-PROJECT §X / Z40 — this feature ships with ZERO Firestore
 * rules change and ZERO new composite index. Pinned against the checked-in
 * files' CONTENT (never a git ref — CI checkouts are shallow), with a
 * positive control that the assertions can see the file at all.
 */

import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..", "..");
const rules = readFileSync(join(root, "firestore.rules"), "utf8");
const indexes = readFileSync(join(root, "firestore.indexes.json"), "utf8");

describe("firestore.rules posture", () => {
  it("positive control: the file is the real ruleset (users block + admin config block present)", () => {
    expect(rules).toMatch(/match \/users\/\{uid\}/);
    expect(rules).toMatch(/match \/appConfig\/modelKeys/);
  });

  // Order 4 Slice 2a added ONE explicit, deny-only block for Workspace Source
  // Standing. It is pinned to its exact deny-only shape here and removed before
  // the original "no other /workspaces match" assertion runs.
  const SOURCE_STANDING_DENY_BLOCK =
    /match \/workspaces\/\{workspaceId\}\/sourceAuthority\/\{sourceId\} \{\s*allow read, write: if false;\s*match \/events\/\{eventId\} \{\s*allow read, write: if false;\s*\}\s*\}/;

  it("the only /workspaces rule is the deny-only Source Standing block", () => {
    expect(rules).toMatch(SOURCE_STANDING_DENY_BLOCK);
    expect(rules.match(/match \/workspaces\b/g)).toHaveLength(1);
  });

  it("the browser still has NO reach into runs, locks, workspaces, projects, or audit events — only the catch-all deny", () => {
    const withoutStandingDeny = rules.replace(SOURCE_STANDING_DENY_BLOCK, "");
    for (const collection of ["runs", "runSnapshotLocks", "workspaces", "workspaceMemberships", "projects", "workspaceMembershipEvents"]) {
      expect(withoutStandingDeny).not.toMatch(new RegExp(`match /${collection}\\b`));
    }
    expect(rules).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  });
});

describe("firestore.indexes.json posture", () => {
  it("no composite index was added for the lock collection (lookups are by deterministic document id)", () => {
    expect(indexes).not.toContain("runSnapshotLocks");
  });
});
