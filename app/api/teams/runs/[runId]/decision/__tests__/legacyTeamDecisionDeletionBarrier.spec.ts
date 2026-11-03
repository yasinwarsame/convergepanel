/**
 * Research deletion integrity (2026-11-03, review round 2 M-2): the legacy Team decision route updates a `teamRuns` row,
 * which carries the research query, with the reviewer's notes. For a research run (`runId` set), the update now runs in
 * a transaction guarded by the deletion barrier. Verification rows (no runId) are unchanged.
 */
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: async () => "admin-uid",
  loadUserAndTeam: async () => ({ team: { id: "team1", members: [{ uid: "admin-uid", role: "admin" }] } }),
  memberRole: () => "admin",
  isTeamAdmin: () => true,
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/teams/runs/[runId]/decision/route";

const post = (teamRunId: string) =>
  POST(new NextRequest(`http://localhost/api/teams/runs/${teamRunId}/decision`, { method: "POST", body: JSON.stringify({ action: "approved", notes: "SECRET reviewer notes" }) }), { params: { runId: teamRunId } } as never);

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  db.seed("runs/run-1", { userId: "u1", question: "SECRET question" });
  db.seed("teamRuns/tr-research", { teamId: "team1", runId: "run-1", query: "SECRET question" });
  db.seed("teamRuns/tr-verification", { teamId: "team1", runId: null, verificationId: "vcl-1", query: "claim" });
});

it("an ordinary research row: the decision is written in a guarded transaction, exactly as before", async () => {
  const res = await post("tr-research");
  expect(res.status).toBe(200);
  expect(db.read("teamRuns/tr-research")!.humanDecision).toEqual(expect.objectContaining({ action: "approved", decidedBy: "admin-uid", notes: "SECRET reviewer notes" }));
  expect(db.writeLog).toEqual([expect.objectContaining({ kind: "update", path: "teamRuns/tr-research", via: "tx" })]);
});

it("a research row whose run's deletion has started: 404, and the notes are not written", async () => {
  db.seed("runDeletionJobs/run-1", { state: "in_progress" });
  const res = await post("tr-research");
  expect(res.status).toBe(404);
  expect(db.read("teamRuns/tr-research")!.humanDecision).toBeUndefined();
  expect(db.writeLog).toEqual([]);
});

it("a verification row (no runId) is unchanged: a direct update, no barrier", async () => {
  db.seed("runDeletionJobs/run-1", { state: "in_progress" });
  const res = await post("tr-verification");
  expect(res.status).toBe(200);
  expect(db.writeLog).toEqual([expect.objectContaining({ kind: "update", path: "teamRuns/tr-verification", via: "direct" })]);
});
