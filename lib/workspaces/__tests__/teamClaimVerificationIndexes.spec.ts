/**
 * TEAM-VERIFICATION-PARITY-R3 — the Team Claim list queries need exactly two
 * composite indexes on `verifications`. Pinned against the checked-in file's
 * CONTENT. Firestore appends `__name__` in the direction of the last ordered
 * field automatically, so no explicit document-id entry exists (matching the
 * existing Team runs indexes).
 */

import { readFileSync } from "fs";
import { join } from "path";

type Field = { fieldPath: string; order?: string };
type Index = { collectionGroup: string; queryScope: string; fields: Field[] };

const indexes = (JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "firestore.indexes.json"), "utf8")) as { indexes: Index[] }).indexes;
const shape = (i: Index) => `${i.collectionGroup}|${i.queryScope}|${i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(",")}`;

describe("Team Claim verification list indexes", () => {
  it("positive control: the existing Team runs Workspace index is visible", () => {
    expect(indexes.map(shape)).toContain("runs|COLLECTION|workspaceId:ASCENDING,createdAt:DESCENDING");
  });

  it.each([
    ["Workspace list (all)", "verifications|COLLECTION|workspaceId:ASCENDING,timestamp:DESCENDING"],
    ["Unfiled and Project lists", "verifications|COLLECTION|workspaceId:ASCENDING,projectId:ASCENDING,timestamp:DESCENDING"],
  ])("%s index is present exactly once", (_l, expected) => {
    expect(indexes.map(shape).filter((s) => s === expected)).toHaveLength(1);
  });

  it("no duplicate or explicit __name__ variant of the Team Claim indexes, and no other workspaceId index on verifications", () => {
    const teamClaim = indexes.filter((i) => i.collectionGroup === "verifications" && i.fields.some((f) => f.fieldPath === "workspaceId"));
    expect(teamClaim).toHaveLength(2);
    expect(JSON.stringify(teamClaim)).not.toContain("__name__");
    expect(new Set(indexes.map(shape)).size).toBe(indexes.length);
  });
});
