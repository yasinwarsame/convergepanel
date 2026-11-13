/**
 * Order 33 — shared helpers for the claim write-path regressions (not a spec). The specs mock the provider SDKs and
 * `fetch` (the network boundary) and an in-memory Firestore (`adminDb`); everything between — the route, the claim
 * dispatch (runClaimVerificationPanel), buildClaimModelEvidence, the persistence call, the read routes, mappers,
 * parsers and components — is the real code.
 */

export type Doc = Record<string, unknown>;

/** In-memory Firestore double: doc get/set/create, transactions, and simple collection queries over the stored docs. */
export function createStore(seed: Record<string, Record<string, Doc>> = {}) {
  const data: Record<string, Map<string, Doc>> = {};
  const col = (name: string) => (data[name] ??= new Map());
  for (const [c, docs] of Object.entries(seed)) for (const [id, d] of Object.entries(docs)) col(c).set(id, d);
  const writes: Array<{ collection: string; id: string; doc: Doc; op: string }> = [];
  const docRef = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => ({ id, exists: col(collection).has(id), data: () => col(collection).get(id) }),
    set: async (d: Doc) => {
      writes.push({ collection, id, doc: d, op: "set" });
      col(collection).set(id, d);
    },
  });
  const query = (name: string): any => {
    const q: any = {};
    for (const m of ["where", "orderBy", "limit", "select", "offset", "startAfter"]) q[m] = () => q;
    q.get = async () => {
      const docs = [...col(name).entries()].map(([id, d]) => ({ id, exists: true, data: () => d, ref: docRef(name, id) }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    };
    q.count = () => ({ get: async () => ({ data: () => ({ count: col(name).size }) }) });
    q.doc = (id: string) => docRef(name, id);
    return q;
  };
  const adminDb: any = {
    collection: (name: string) => query(name),
    getAll: async (...refs: Array<{ path: string }>) =>
      refs.map((r) => {
        const [c, id] = r.path.split("/");
        return { id, exists: col(c).has(id), data: () => col(c).get(id) };
      }),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        create: (ref: { path: string }, d: Doc) => {
          const [c, id] = ref.path.split("/");
          writes.push({ collection: c, id, doc: d, op: "create" });
          col(c).set(id, d);
        },
        set: (ref: { path: string }, d: Doc) => {
          const [c, id] = ref.path.split("/");
          writes.push({ collection: c, id, doc: d, op: "set" });
          col(c).set(id, d);
        },
        update: () => {},
      };
      return fn(tx);
    },
  };
  return { adminDb, writes, col };
}

/** A claim verdict as a provider would return it (the JSON the claim prompt asks for). */
export function verdictJson(verdict: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ verdict, confidence: "high", summary: `${verdict} summary`, correctParts: ["Built in 1889"], incorrectParts: [], unverifiableParts: [], reasoning: "r", ...extra });
}

/** Mock behaviour per provider boundary. */
export type Behaviour = { kind: "answer"; text: string } | { kind: "timeout" } | { kind: "http500" } | { kind: "refuse429" };

export function openAIResponder(b: Behaviour) {
  if (b.kind === "answer") return Promise.resolve({ choices: [{ message: { content: b.text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
  if (b.kind === "timeout") return Promise.reject(new Error("timeout"));
  if (b.kind === "refuse429") return Promise.reject(Object.assign(new Error("rate limit"), { status: 429 }));
  return Promise.reject(Object.assign(new Error("server error"), { status: 500 }));
}
export function anthropicResponder(b: Behaviour) {
  if (b.kind === "answer") return Promise.resolve({ content: [{ type: "text", text: b.text }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } });
  if (b.kind === "timeout") return Promise.reject(new Error("timeout"));
  if (b.kind === "refuse429") return Promise.reject(Object.assign(new Error("rate limit"), { status: 429 }));
  return Promise.reject(Object.assign(new Error("server error"), { status: 500 }));
}
export function grokFetchResponse(b: Behaviour): Promise<Response> {
  if (b.kind === "answer")
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: b.text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }), { status: 200, headers: { "Content-Type": "application/json" } }));
  if (b.kind === "timeout") return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return Promise.resolve(new Response(JSON.stringify({ error: { message: "boom" } }), { status: b.kind === "refuse429" ? 429 : 500, headers: { "Content-Type": "application/json" } }));
}

export const silence = () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
};
