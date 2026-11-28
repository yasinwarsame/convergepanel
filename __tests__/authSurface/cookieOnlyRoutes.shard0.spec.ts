/** ZCA L-1 — cookie-only authorization oracle, shard 0 of 4 (see cookieOnlyOracle.ts). */
jest.mock("@/lib/firebase/admin", () => require("./routeHarness").firebaseAdminMock());
jest.mock("@/lib/stripe/client", () => require("./routeHarness").stripeClientMock());
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn(async () => Buffer.from("")) }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { defineCookieOnlyOracle } from "./cookieOnlyOracle";

defineCookieOnlyOracle(0, 4);
