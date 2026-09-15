/**
 * PR #164 review C4 — a persisted Project assignee list with MORE THAN 20
 * unique valid-looking uids is an integrity anomaly, normalized to `[]`
 * under the one deterministic safe representation. Proven with 1,000
 * unique persisted uids: no membership/name batch of any size is issued,
 * the page/DTO stays usable, the stored anomaly never reaches the client,
 * the repair write stays possible with a BOUNDED audit payload, and the
 * anomaly is logged without the raw list. The request-side rule (dedupe
 * first, cap on unique before target reads) is unchanged — positive
 * controls included.
 */

const getAllSpy = jest.fn();
const memberships = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({ doc: (id: string) => ({ __collection: name, __id: id }) }),
      getAll: (...refs: { __id: string }[]) => {
        getAllSpy(refs.length);
        return Promise.resolve(refs.map((r) => ({ exists: memberships.has(r.__id), data: () => memberships.get(r.__id) })));
      },
    };
  },
}));
const mockNames = jest.fn();
jest.mock("../workspaceReviewerIdentity", () => ({
  REVIEWER_UNAVAILABLE_LABEL: "Unavailable reviewer",
  resolveWorkspaceReviewerDisplayNames: (...a: unknown[]) => mockNames(...a),
}));
const mockedLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));

import { Timestamp } from "firebase-admin/firestore";
import { normalizeStoredAssigneeUids, canonicalizeAssigneeUids, diffAssigneeUids, MAX_PROJECT_ASSIGNEES } from "../assignmentNormalization";
import { enrichTeamProjectDtos } from "../teamProjectAssigneeEnrichment";

const WS = "ws-1";
const BIG = Array.from({ length: 1000 }, (_, i) => `persisted-user-${String(i).padStart(4, "0")}`);
const project = (assigneeUids: unknown) => ({ project: { schemaVersion: 1, id: "p1", workspaceId: WS, name: "P", status: "active", createdByUserId: "o", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), assigneeUids } as never, documentUpdateTime: null as never });

beforeEach(() => {
  getAllSpy.mockClear();
  mockedLogger.warn.mockClear();
  mockNames.mockReset();
  mockNames.mockImplementation(async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])));
});

describe("stored-side rule", () => {
  it("absent ⇒ [] not malformed; ≤ 20 unique ⇒ canonical; EXACTLY 20 unique is still valid (boundary)", () => {
    expect(normalizeStoredAssigneeUids(undefined)).toEqual({ uids: [], malformed: false });
    const twenty = BIG.slice(0, MAX_PROJECT_ASSIGNEES);
    expect(normalizeStoredAssigneeUids([...twenty, twenty[0]])).toEqual({ uids: twenty, malformed: false });
  });
  it("21 unique and 1,000 unique valid-looking uids ⇒ the SAME safe representation as any other anomaly: [] with malformed: true", () => {
    expect(normalizeStoredAssigneeUids(BIG.slice(0, 21))).toEqual({ uids: [], malformed: true });
    expect(normalizeStoredAssigneeUids(BIG)).toEqual({ uids: [], malformed: true });
    expect(normalizeStoredAssigneeUids("x")).toEqual({ uids: [], malformed: true });
  });
  it("request-side rule unchanged: 1,000 raw entries collapsing to ≤ 20 unique remain valid; > 20 unique rejected before any read", () => {
    expect(canonicalizeAssigneeUids(Array.from({ length: 1000 }, (_, i) => BIG[i % 5])).ok).toBe(true);
    expect(canonicalizeAssigneeUids(BIG)).toEqual({ ok: false, reason: "too_many_assignees" });
  });
});

describe("presentation / enrichment with 1,000 persisted uids", () => {
  it("performs NO membership batch and NO name batch; the DTO is usable with assignees: []; the anomaly is logged WITHOUT the raw list (positive control: a valid sibling row is enriched)", async () => {
    const dtos = await enrichTeamProjectDtos(WS, [project(BIG), project(["persisted-user-0000"])]);
    expect(dtos).toHaveLength(2);
    expect(dtos[0].assignees).toEqual([]);
    expect(dtos[1].assignees).toHaveLength(1);
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(getAllSpy).toHaveBeenCalledWith(1); // only the valid sibling's single uid
    expect(mockNames.mock.calls[0][1]).toEqual(["persisted-user-0000"]);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mockedLogger.warn.mock.calls);
    expect(logged).not.toContain("persisted-user-0001");
    expect(logged.length).toBeLessThan(600);
    expect(JSON.stringify(dtos)).not.toContain("persisted-user-0999");
  });
});

describe("repair path stays bounded", () => {
  it("a repair of a 1,000-uid stored list diffs against the normalized [] — removedUids is EMPTY, never 1,000 entries", () => {
    const stored = normalizeStoredAssigneeUids(BIG);
    expect(diffAssigneeUids(stored.uids, [])).toEqual({ addedUids: [], removedUids: [] });
    expect(diffAssigneeUids(stored.uids, ["persisted-user-0000"])).toEqual({ addedUids: ["persisted-user-0000"], removedUids: [] });
  });
});
