/** The Firestore double of the governance inventory (no imports: it is required from a jest.mock factory). */
export const govState: { rows: Array<{ id: string; data: Record<string, unknown> }> } = { rows: [] };

/** The Firestore double (installed by the spec's jest.mock factory). */
export function govQuery(name: string, fields: string[] | null): unknown {
  const rows = () => (name === "verifications" ? govState.rows : []);
  const project = (data: Record<string, unknown>) => (fields ? Object.fromEntries(fields.filter((f) => f in data).map((f) => [f, data[f]])) : data);
  return {
    where: () => govQuery(name, fields),
    orderBy: () => govQuery(name, fields),
    limit: () => govQuery(name, fields),
    select: (...f: string[]) => govQuery(name, f),
    get: async () => ({ docs: rows().map((r) => ({ id: r.id, data: () => project(r.data) })), size: rows().length }),
  };
}

