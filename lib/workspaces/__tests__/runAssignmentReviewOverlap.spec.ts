/** Project/Research Assignment (D8) — the read-only reviewer-overlap presentation reader. */
let docs: Record<string, Record<string, unknown> | undefined> = {};
let getAllShouldThrow = false;
let adminDbAvailable = true;
const getAllSpy = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    if (!adminDbAvailable) return null;
    return {
      collection: () => ({
        doc: (runId: string) => ({
          collection: (sub: string) => ({ doc: () => ({ __key: `${runId}/${sub}` }) }),
        }),
      }),
      getAll: (...refs: { __key: string }[]) => {
        getAllSpy(...refs);
        if (getAllShouldThrow) return Promise.reject(new Error("boom"));
        return Promise.resolve(refs.map((r) => ({ exists: docs[r.__key] !== undefined, data: () => docs[r.__key] })));
      },
    };
  },
}));

import { readRunReviewerUidsForAssignmentWarning } from "../runAssignmentReviewOverlap";

beforeEach(() => {
  docs = {};
  getAllShouldThrow = false;
  adminDbAvailable = true;
  getAllSpy.mockClear();
});

it("reads both frozen documents in ONE getAll and unions the single reviewer with an OPEN panel's members, sorted", async () => {
  docs["run-1/humanReviewAssignment"] = { assignedReviewerUserId: "zed" };
  docs["run-1/humanReviewPanel"] = { status: "open", reviewerUserIds: ["bob", "amy", "zed"] };
  expect(await readRunReviewerUidsForAssignmentWarning("run-1")).toEqual(["amy", "bob", "zed"]);
  expect(getAllSpy).toHaveBeenCalledTimes(1);
  expect(getAllSpy.mock.calls[0]).toHaveLength(2);
});

it("a non-open panel contributes nothing; malformed fields are ignored structurally (never parsed through review code)", async () => {
  docs["run-1/humanReviewPanel"] = { status: "closed", reviewerUserIds: ["bob"] };
  docs["run-1/humanReviewAssignment"] = { assignedReviewerUserId: 42 };
  expect(await readRunReviewerUidsForAssignmentWarning("run-1")).toEqual([]);
  docs["run-1/humanReviewPanel"] = { status: "open", reviewerUserIds: "bob" };
  expect(await readRunReviewerUidsForAssignmentWarning("run-1")).toEqual([]);
});

it("never throws: read failure and unavailable Firestore both yield [] (positive control above returns uids)", async () => {
  getAllShouldThrow = true;
  expect(await readRunReviewerUidsForAssignmentWarning("run-1")).toEqual([]);
  adminDbAvailable = false;
  expect(await readRunReviewerUidsForAssignmentWarning("run-1")).toEqual([]);
});
