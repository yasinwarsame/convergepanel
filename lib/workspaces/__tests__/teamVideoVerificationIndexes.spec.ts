/**
 * TEAM-VERIFICATION-PARITY-R5-I1 — the Team Video list queries need exactly two
 * composite indexes on `videoVerifications`. Pinned against the checked-in
 * file's CONTENT. Firestore appends `__name__` in the direction of the last
 * ordered field automatically, so no explicit document-id entry exists
 * (matching the existing Team Claim and Team runs indexes).
 *
 * The existing Personal Video indexes must remain visible and untouched —
 * including the incidental `FileName` (capital F) one, whose capitalization
 * mismatch with the writer's `fileName` is a SEPARATE, explicitly deferred
 * finding that R5-I1 must not "fix". This suite pins it as-is so a drive-by
 * correction fails loudly rather than riding along in this PR.
 */

import { readFileSync } from "fs";
import { join } from "path";

type Field = { fieldPath: string; order?: string };
type Index = { collectionGroup: string; queryScope: string; fields: Field[] };

const indexes = (JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "firestore.indexes.json"), "utf8")) as { indexes: Index[] }).indexes;
const shape = (i: Index) => `${i.collectionGroup}|${i.queryScope}|${i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(",")}`;

const WORKSPACE_ALL = "videoVerifications|COLLECTION|workspaceId:ASCENDING,timestamp:DESCENDING";
const WORKSPACE_PROJECT = "videoVerifications|COLLECTION|workspaceId:ASCENDING,projectId:ASCENDING,timestamp:DESCENDING";

describe("Team Video verification list indexes", () => {
  it("positive control: the existing Team Claim Workspace index is visible", () => {
    expect(indexes.map(shape)).toContain("verifications|COLLECTION|workspaceId:ASCENDING,timestamp:DESCENDING");
  });

  it.each([
    ["Workspace list (all)", WORKSPACE_ALL],
    ["Unfiled and Project lists", WORKSPACE_PROJECT],
  ])("%s index is present exactly once", (_l, expected) => {
    expect(indexes.map(shape).filter((s) => s === expected)).toHaveLength(1);
  });

  it("exactly two workspaceId indexes on videoVerifications, with no explicit __name__ variant", () => {
    const teamVideo = indexes.filter((i) => i.collectionGroup === "videoVerifications" && i.fields.some((f) => f.fieldPath === "workspaceId"));
    expect(teamVideo.map(shape).sort()).toEqual([WORKSPACE_PROJECT, WORKSPACE_ALL].sort());
    expect(JSON.stringify(teamVideo)).not.toContain("__name__");
  });

  it("no duplicate index definitions anywhere in the file", () => {
    expect(new Set(indexes.map(shape)).size).toBe(indexes.length);
  });

  it("the three pre-existing Personal videoVerifications indexes are untouched, FileName capitalization included (deferred finding)", () => {
    const personal = indexes.filter((i) => i.collectionGroup === "videoVerifications" && !i.fields.some((f) => f.fieldPath === "workspaceId"));
    expect(personal.map(shape).sort()).toEqual(
      [
        "videoVerifications|COLLECTION|userId:ASCENDING,timestamp:DESCENDING",
        "videoVerifications|COLLECTION|userId:ASCENDING,governanceStatus:ASCENDING,timestamp:DESCENDING",
        "videoVerifications|COLLECTION|FileName:ASCENDING,userId:ASCENDING,timestamp:DESCENDING",
      ].sort()
    );
  });
});
