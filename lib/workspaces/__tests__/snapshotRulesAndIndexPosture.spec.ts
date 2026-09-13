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

  it("the browser still has NO reach into runs, locks, workspaces, projects, or audit events — only the catch-all deny", () => {
    for (const collection of ["runs", "runSnapshotLocks", "workspaces", "workspaceMemberships", "projects", "workspaceMembershipEvents"]) {
      expect(rules).not.toMatch(new RegExp(`match /${collection}\\b`));
    }
    expect(rules).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  });
});

describe("firestore.indexes.json posture", () => {
  it("no composite index was added for the lock collection (lookups are by deterministic document id)", () => {
    expect(indexes).not.toContain("runSnapshotLocks");
  });
});
