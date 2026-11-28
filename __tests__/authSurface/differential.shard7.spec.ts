/** ZCA P3 R2 L-3 — behavioural differential, shard 7 of 8 (see differentialOracle.ts). Only network edges are faked. */
jest.mock("@/lib/firebase/admin", () => require("./routeHarness").firebaseAdminMock());
jest.mock("@/lib/stripe/client", () => require("./routeHarness").stripeClientMock());
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn(async () => Buffer.from("")) }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { defineDifferential, DIFFERENTIAL_SHARDS } from "./differentialOracle";

defineDifferential(7, DIFFERENTIAL_SHARDS);
