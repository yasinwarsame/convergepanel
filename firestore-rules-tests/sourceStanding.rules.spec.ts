/**
 * Order 4 Slice 2a — Workspace Source Standing is server-only. The browser
 * (any signed-in user, including an `admin` claim and the Workspace Owner)
 * can neither read nor write the current-state documents or their history,
 * and cannot list or query them. Seeded through the privileged path so every
 * "read denied" is against a document that genuinely exists.
 */
import { readFileSync } from "fs";
import { initializeTestEnvironment, assertFails, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

const WS = "ws-rules-1";
const ID = "a".repeat(64);
const CURRENT = `workspaces/${WS}/sourceAuthority/${ID}`;
const EVENT = `${CURRENT}/events/e1`;
const RECORD = { schemaVersion: 1, workspaceId: WS, identity: { identityVersion: 1, canonicalUrl: "https://docs.example.com/a", idHash: ID }, status: "ACCEPTED", reasonCode: "primary_document", revision: 1, updatedAt: new Date(0), updatedByUid: "owner-1" };

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-source-standing-rules",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080) },
  });
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), CURRENT), RECORD);
    await setDoc(doc(ctx.firestore(), EVENT), { schemaVersion: 1, fromStatus: null, toStatus: "ACCEPTED", reasonCode: "primary_document", revision: 1, actorUid: "owner-1", actorRole: "owner", at: new Date(0) });
  });
});

const principals = () => [
  ["unauthenticated", env.unauthenticatedContext().firestore()],
  ["signed-in owner", env.authenticatedContext("owner-1").firestore()],
  ["admin claim", env.authenticatedContext("root-1", { admin: true }).firestore()],
] as const;

it("positive control: the seeded documents exist (read through the privileged path)", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    expect((await getDoc(doc(ctx.firestore(), CURRENT))).exists()).toBe(true);
    expect((await getDoc(doc(ctx.firestore(), EVENT))).exists()).toBe(true);
  });
});

it.each([0, 1, 2])("principal #%i: get / list / collection-group of current state and history are denied", async (i) => {
  const [, db] = principals()[i];
  await assertFails(getDoc(doc(db, CURRENT)));
  await assertFails(getDoc(doc(db, EVENT)));
  await assertFails(getDocs(collection(db, `workspaces/${WS}/sourceAuthority`)));
  await assertFails(getDocs(collection(db, `${CURRENT}/events`)));
  await assertFails(getDocs(collectionGroup(db, "sourceAuthority")));
  await assertFails(getDocs(collectionGroup(db, "events")));
});

it.each([0, 1, 2])("principal #%i: create / update / delete of current state and history are denied", async (i) => {
  const [, db] = principals()[i];
  await assertFails(setDoc(doc(db, `workspaces/${WS}/sourceAuthority/${"b".repeat(64)}`), RECORD));
  await assertFails(updateDoc(doc(db, CURRENT), { status: "DISPUTED" }));
  await assertFails(deleteDoc(doc(db, CURRENT)));
  await assertFails(setDoc(doc(db, `${CURRENT}/events/e2`), { toStatus: "WITHDRAWN" }));
  await assertFails(updateDoc(doc(db, EVENT), { toStatus: "WITHDRAWN" }));
  await assertFails(deleteDoc(doc(db, EVENT)));
});
