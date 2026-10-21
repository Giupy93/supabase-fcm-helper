// Optional filters and result pagination for get-entries. This module does not
// select authorized users, generate entries, deduplicate or sanitize responses:
// those steps remain in the original get-entries handler.
export class EntryRequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
export function civilDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
    throw new EntryRequestError("Invalid date");
  }
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T12:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  ) throw new EntryRequestError("Invalid date");
  return day;
}
export interface EntryReadOptions {
  search: boolean;
  extended: boolean;
  startDate?: string;
  endDate?: string;
  query: string;
  type?: number;
  mode?: "personal" | "band";
  groupId?: string;
  offset: number;
}
export function parseEntryReadOptions(body: any): EntryReadOptions {
  const search = body.search === true;
  const extended = search || body.end_date != null;
  const options: EntryReadOptions = { search, extended, query: "", offset: 0 };
  // Old callers still go through the original validation and data pipeline.
  if (!extended) return options;
  options.startDate = civilDate(body.start_date ?? "0001-01-01");
  if (body.end_date != null) options.endDate = civilDate(body.end_date);
  if (options.endDate && options.endDate <= options.startDate) {
    throw new EntryRequestError("Invalid date interval");
  }
  if (!search) return options;
  if (
    body.query != null &&
    (typeof body.query !== "string" || body.query.length > 200)
  ) throw new EntryRequestError("Invalid query");
  options.query = (body.query ?? "").trim().toLocaleLowerCase();
  if (body.type != null && ![0, 1, 2].includes(body.type)) {
    throw new EntryRequestError("Invalid type");
  }
  options.type = body.type ?? undefined;
  if (body.mode != null && !["personal", "band"].includes(body.mode)) {
    throw new EntryRequestError("Invalid mode");
  }
  options.mode = body.mode ?? "band";
  if (
    body.group_id != null &&
    (typeof body.group_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        body.group_id,
      ))
  ) throw new EntryRequestError("Invalid group_id");
  options.groupId = body.group_id ?? undefined;
  if (body.cursor != null) {
    const cursor = body.cursor;
    if (
      typeof cursor !== "object" || !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 || cursor.offset > 10000000 ||
      Object.keys(cursor).some((key) => key !== "offset")
    ) throw new EntryRequestError("Invalid cursor");
    options.offset = cursor.offset;
  }
  return options;
}

// Only new calls explicitly requesting a bounded period or search need complete
// source sets. Legacy calls await their original query unchanged. Keep the
// original source order: generated entries choose the first source per user/day.
export async function entryQueryResult(
  makeQuery: () => any,
  extended: boolean,
): Promise<{ data: any[] | null; error: any }> {
  if (!extended) return await makeQuery();
  const rows: any[] = [];
  for (let offset = 0;;) {
    const { data, error, count } = await makeQuery().range(
      offset,
      offset + 199,
    );
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    offset += data?.length ?? 0;
    // Exact counts are requested only for new calls; also works with a project
    // row cap smaller than our requested batch size.
    if (
      !data?.length || (count != null ? offset >= count : data.length < 200)
    ) return { data: rows, error: null };
  }
}

export function filterEntryResults(
  entries: any[],
  options: EntryReadOptions,
  context: {
    userId: string;
    projectId: string;
    currentRole: number;
    groups: any[];
  },
) {
  if (!options.extended) return entries;
  let result = entries.filter((entry) => {
    const day = civilDate(entry.start_date);
    return day >= options.startDate! &&
      (!options.endDate || day < options.endDate);
  });
  if (!options.search) return result;
  const group = options.groupId
    ? context.groups.find((g) => g.id === options.groupId)
    : null;
  if (options.groupId && !group) {
    throw new EntryRequestError("Invalid group for project");
  }
  const members = group
    ? group.groupUser ?? []
    : context.groups.flatMap((g) => g.groupUser ?? []);
  const groupUserIds = new Set(members.map((m: any) => m.user_id));
  const personal = context.currentRole === 2 || options.mode === "personal";
  result = result.filter((entry) => {
    // These only narrow the already-authorized original result set.
    if (
      personal
        ? !(entry.user_id === context.userId ||
          entry.project_id === context.projectId)
        : !(entry.project_id === context.projectId ||
          groupUserIds.has(entry.user_id))
    ) return false;
    const displayedType = !personal && entry.project_id !== context.projectId
      ? 0
      : entry.type;
    if (options.type != null && displayedType !== options.type) return false;
    const text = `${entry.description ?? entry.motivo ?? ""} ${
      entry.city ?? ""
    }`.toLocaleLowerCase();
    return text.includes(options.query);
  });
  // Only search needs a deterministic tie-breaker for result pages. The legacy
  // and bounded-calendar responses retain the original date-only ordering.
  result.sort((a, b) =>
    new Date(a.start_date).getTime() - new Date(b.start_date).getTime() ||
    String(a.id).localeCompare(String(b.id), "en")
  );
  const page = result.slice(options.offset, options.offset + 50).map((entry) =>
    !personal && entry.project_id !== context.projectId
      ? { ...entry, type: 0 }
      : entry
  );
  const next = options.offset + page.length;
  return {
    entries: page,
    next_cursor: next < result.length ? { offset: next } : null,
  };
}
