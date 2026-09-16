import type { Candidate, Stage } from "./types";

export const UNKNOWN = "Not provided";
export type MetricsFilters = {
  from: string;
  to: string;
  dateBasis: "applied" | "added";
  experience: string;
  role: string;
  source: string;
  stage: string;
  applicantType: string;
  decision: string;
};
export const EMPTY_FILTERS: MetricsFilters = {
  from: "",
  to: "",
  dateBasis: "applied",
  experience: "",
  role: "",
  source: "",
  stage: "",
  applicantType: "",
  decision: "",
};
export const label = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : UNKNOWN;

// Keep the calendar day supplied by the source. Never interpret ambiguous dates
// or count a historical sheet import as new lead acquisition.
export function calendarDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/);
  if (!match) return null;
  const day = match[1];
  const time = Date.parse(day + "T00:00:00Z");
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === day
    ? day
    : null;
}
export function candidateDay(c: Candidate, basis: MetricsFilters["dateBasis"]) {
  if (basis === "added") return calendarDay(c.created_at);
  const supplied = c.attributes["Applied at"];
  if (typeof supplied === "string" && supplied.trim())
    return calendarDay(supplied);
  return c.source === "Hiring Sheet" ? null : calendarDay(c.created_at);
}
export function filterCandidates(
  candidates: Candidate[],
  companyId: string,
  f: MetricsFilters,
) {
  return candidates.filter((c) => {
    if (c.company_id !== companyId) return false;
    const date = candidateDay(c, f.dateBasis);
    return (
      (!f.from || (!!date && date >= f.from)) &&
      (!f.to || (!!date && date <= f.to)) &&
      (!f.experience || label(c.experience) === f.experience) &&
      (!f.role || label(c.job_title) === f.role) &&
      (!f.source || label(c.source) === f.source) &&
      (!f.stage || c.stage_id === f.stage) &&
      (!f.applicantType ||
        label(c.attributes["Applicant Type"]) === f.applicantType) &&
      (!f.decision || label(c.attributes.Decision) === f.decision)
    );
  });
}
export type Breakdown = { name: string; count: number; id?: string }[];
export function breakdown(
  candidates: Candidate[],
  get: (c: Candidate) => unknown,
): Breakdown {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const name = label(get(c));
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
export function uniqueContacts(candidates: Candidate[]) {
  // This is a contact-key count, not an assertion that two people are identical.
  return new Set(
    candidates.map((c) =>
      c.email?.trim()
        ? `email:${c.email.trim().toLowerCase()}`
        : c.phone?.trim()
          ? `phone:${c.phone.trim()}`
          : `record:${c.id}`,
    ),
  ).size;
}
export function stageBreakdown(
  candidates: Candidate[],
  stages: Stage[],
  companyId: string,
): Breakdown {
  return stages
    .filter((s) => s.company_id === companyId)
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      id: s.id,
      name: s.name,
      count: candidates.filter((c) => c.stage_id === s.id).length,
    }));
}
const DAY = 86400000;
export function volumeSeries(candidates: Candidate[], f: MetricsFilters) {
  const dates = candidates
    .map((c) => candidateDay(c, f.dateBasis))
    .filter((d): d is string => !!d)
    .sort();
  const first = f.from || dates[0];
  const last = f.to || dates.at(-1);
  if (!first || !last || first > last) return { unit: "day", points: [] };
  const span = (Date.parse(last) - Date.parse(first)) / DAY;
  const unit = span <= 45 ? "day" : span <= 180 ? "week" : "month";
  const bucket = (day: string) => {
    if (unit === "month") return day.slice(0, 7) + "-01";
    if (unit === "day") return day;
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const counts = new Map<string, number>();
  for (const day of dates)
    counts.set(bucket(day), (counts.get(bucket(day)) || 0) + 1);
  const points: { date: string; count: number }[] = [];
  const end = bucket(last);
  for (let cursor = bucket(first); cursor <= end;) {
    points.push({ date: cursor, count: counts.get(cursor) || 0 });
    const d = new Date(cursor + "T00:00:00Z");
    if (unit === "month") d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + (unit === "week" ? 7 : 1));
    cursor = d.toISOString().slice(0, 10);
  }
  return { unit, points };
}
