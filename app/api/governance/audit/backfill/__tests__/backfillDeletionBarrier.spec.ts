/**
 * Research deletion integrity (2026-11-03) — the governance audit backfill copies a run's `governanceEvents` into
 * `admin_audit_logs` (question + comment) from a read made BEFORE the write. Without the deletion barrier a run deleted
 * meanwhile could have its REDACTED audit row overwritten with the deleted text (set-merge onto a deterministic id).
 * The write for a research run is now guarded; verifications are unchanged.
 */
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/admin/privilegedAccess", () => ({
  ...jest.requireActual("@/lib/admin/privilegedAccess"),
  // SEC-3 / S2-b: the POST guard is granted here (this file tests what is BEHIND it); the real guard's
  // GOVERNANCE_ADMIN wiring is proven in app/api/admin/__tests__/privilegedRouteWiring.spec.ts.
  requirePrivilegedAccess: async () => ({ ok: true, actor: { uid: "admin-uid", email: "a@x.test", tier: "GOVERNANCE_ADMIN" } }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/governance/audit/backfill/route";

const SECRET_Q = "SECRET deleted question";
const SECRET_C = "SECRET reviewer comment";
const post = () => POST(new NextRequest("http://localhost/api/governance/audit/backfill", { method: "POST" }));
const rowId = (collection: string, id: string) => `admin_audit_logs/backfill__${collection}__${id}__ev1`;

function seedParent(collection: "runs" | "verifications", id: string, extra: Record<string, unknown> = {}) {
  db.seed(`${collection}/${id}`, { userId: "owner", userEmail: "o@x.test", question: SECRET_Q, claim: SECRET_Q, governanceStatus: "approved", ...extra });
  db.seed(`${collection}/${id}/governanceEvents/ev1`, { action: "approved", byUid: "rev", comment: SECRET_C, at: "2026-01-01T00:00:00.000Z" });
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it("an ordinary research run and a verification are backfilled exactly as before (question + comment, backfilled:true)", async () => {
  seedParent("runs", "run-ok");
  seedParent("verifications", "vcl-ok");
  const res = await post();
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ ok: true, written: 2 });
  for (const [c, id] of [["runs", "run-ok"], ["verifications", "vcl-ok"]] as const) {
    expect(db.read(rowId(c, id))).toEqual(expect.objectContaining({ runId: id, collection: c, action: "approved", comment: SECRET_C, question: SECRET_Q, backfilled: true }));
  }
  expect(db.writeLog.find((w) => w.path === rowId("runs", "run-ok"))!.via).toBe("tx"); // the research-run row is guarded
  expect(db.writeLog.find((w) => w.path === rowId("verifications", "vcl-ok"))!.via).toBe("direct"); // unchanged path
});

it("a run marked for deletion (still listed by the query) is skipped: its redacted audit row is NOT overwritten with the deleted text", async () => {
  seedParent("runs", "run-del", { deletion: { state: "pending" } });
  db.seed(rowId("runs", "run-del"), { runId: "run-del", question: "[deleted research]", comment: "[deleted research]", contentRedacted: true });
  const res = await post();
  await expect(res.json()).resolves.toMatchObject({ ok: true, written: 0 });
  expect(db.read(rowId("runs", "run-del"))).toEqual({ runId: "run-del", question: "[deleted research]", comment: "[deleted research]", contentRedacted: true });
});

it("a run with a deletion tombstone is skipped, and the tombstone is never written by the backfill", async () => {
  seedParent("runs", "run-tomb");
  db.seed("runDeletionJobs/run-tomb", { state: "in_progress" });
  const res = await post();
  await expect(res.json()).resolves.toMatchObject({ ok: true, written: 0 });
  expect(db.read(rowId("runs", "run-tomb"))).toBeUndefined();
  expect(db.writeLog.some((w) => w.path.startsWith("runDeletionJobs/"))).toBe(false);
});

it("a deletion that starts after the backfill read the run, but before its write commits, refuses that write", async () => {
  seedParent("runs", "run-race");
  let fired = false;
  db.hooks.afterTxReads = () => {
    if (fired) return;
    fired = true;
    db.seed("runDeletionJobs/run-race", { state: "in_progress" }); // the tombstone lands between read and commit
  };
  const res = await post();
  expect(fired).toBe(true);
  await expect(res.json()).resolves.toMatchObject({ ok: true, written: 0 });
  expect(db.read(rowId("runs", "run-race"))).toBeUndefined();
});
