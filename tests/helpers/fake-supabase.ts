/**
 * Minimal chainable stand-in for the Supabase query builder.
 * Every call is recorded; a handler decides what each finished query returns.
 */
export type Call = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, ...unknown[]]>;
};

export type Handler = (call: Call) => { data?: unknown; error?: { message: string } | null; count?: number };

export function createFakeSupabase(handler: Handler = () => ({ data: [] })) {
  const calls: Call[] = [];

  function builder(table: string) {
    const call: Call = { table, op: "select", filters: [] };
    const q: Record<string, unknown> = {};
    const chain = (name: string) => (...args: unknown[]) => {
      call.filters.push([name, ...args]);
      return q;
    };
    q.select = (...args: unknown[]) => {
      if (call.op === "select") call.payload = args[0];
      return q;
    };
    q.insert = (payload: unknown) => ((call.op = "insert"), (call.payload = payload), q);
    q.update = (payload: unknown) => ((call.op = "update"), (call.payload = payload), q);
    q.upsert = (payload: unknown, options: unknown) => (
      (call.op = "upsert"), (call.payload = payload), (call.options = options), q
    );
    q.delete = () => ((call.op = "delete"), q);
    for (const f of ["eq", "neq", "in", "not", "gte", "lte", "order", "limit", "is"]) q[f] = chain(f);
    const finish = () => {
      calls.push(call);
      const r = handler(call);
      return { data: r.data ?? null, error: r.error ?? null, count: r.count };
    };
    q.single = async () => finish();
    q.maybeSingle = async () => finish();
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(finish).then(resolve, reject);
    return q;
  }

  return {
    calls,
    from: (table: string) => builder(table),
    auth: { getUser: async () => ({ data: { user: null } }) },
  };
}
