"use client";
import { useMemo, useState } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import type { Candidate, Workspace } from "@/lib/types";
import {
  breakdown,
  candidateDay,
  EMPTY_FILTERS,
  filterCandidates,
  label,
  stageBreakdown,
  uniqueContacts,
  volumeSeries,
  type Breakdown,
  type MetricsFilters,
} from "@/lib/metrics";
import "./metrics.css";

const format = new Intl.NumberFormat("en-CA");
const shortDate = (day: string) =>
  new Date(day + "T00:00:00Z").toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
function Bars({
  title,
  rows,
  total,
  onChoose,
  description,
}: {
  title: string;
  rows: Breakdown;
  total: number;
  onChoose?: (row: Breakdown[number]) => void;
  description?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="metrics-panel">
      <h2>{title}</h2>
      {description && <p className="metrics-caption">{description}</p>}
      {rows.length ? (
        <div className="metrics-bars">
          {rows.map((row) => {
            const content = (
              <>
                <span className="metrics-bar-label">{row.name}</span>
                <span className="metrics-bar-track" aria-hidden="true">
                  <span style={{ width: `${(row.count / max) * 100}%` }} />
                </span>
                <strong>{format.format(row.count)}</strong>
                <span className="metrics-share">
                  {total ? Math.round((row.count / total) * 100) : 0}%
                </span>
              </>
            );
            return onChoose ? (
              <button
                className="metrics-bar-row"
                key={row.id || row.name}
                onClick={() => onChoose(row)}
                aria-label={`Filter ${title}: ${row.name}, ${row.count} applications`}
              >
                {content}
              </button>
            ) : (
              <div className="metrics-bar-row" key={row.id || row.name}>
                {content}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="metrics-empty">No matching applications.</p>
      )}
    </section>
  );
}
export function Metrics({
  data,
  onCandidate,
}: {
  data: Workspace;
  onCandidate: (candidate: Candidate) => void;
}) {
  const [filters, setFilters] = useState<MetricsFilters>({ ...EMPTY_FILTERS });
  const [page, setPage] = useState(0);
  const company = data.company!.id;
  const candidates = useMemo(
    () => data.candidates.filter((c) => c.company_id === company),
    [data.candidates, company],
  );
  const update = (key: keyof MetricsFilters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(0);
  };
  const invalidRange = !!(
    filters.from &&
    filters.to &&
    filters.from > filters.to
  );
  const filtered = useMemo(
    () => filterCandidates(candidates, company, filters),
    [candidates, company, filters],
  );
  const unique = uniqueContacts(filtered);
  const stages = stageBreakdown(filtered, data.stages, company);
  const hired = stages
    .filter((s) => s.name.toLowerCase() === "hired")
    .reduce((n, s) => n + s.count, 0);
  const series = volumeSeries(filtered, filters);
  const max = Math.max(1, ...series.points.map((p) => p.count));
  const unknownDates = candidates.filter(
    (c) => !candidateDay(c, filters.dateBasis),
  ).length;
  const decisions = candidates.filter(
    (c) =>
      typeof c.attributes.Decision === "string" && c.attributes.Decision.trim(),
  ).length;
  const select = (
    title: string,
    key: keyof MetricsFilters,
    options: string[],
  ) => (
    <label className="metrics-field">
      {title}
      <select
        value={filters[key]}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="">All</option>
        {options.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </label>
  );
  const options = (get: (c: Candidate) => unknown) =>
    [...new Set(candidates.map((c) => label(get(c))))].sort();
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const safePage = Math.min(page, pages - 1);
  const sorted = [...filtered].sort(
    (a, b) =>
      (candidateDay(b, filters.dateBasis) || "").localeCompare(
        candidateDay(a, filters.dateBasis) || "",
      ) || a.name.localeCompare(b.name),
  );
  const hasFilters = Object.entries(filters).some(
    ([key, value]) => value !== EMPTY_FILTERS[key as keyof MetricsFilters],
  );
  const preset = (days: number | null) => {
    const today = new Date();
    const to = today.toISOString().slice(0, 10);
    today.setUTCDate(today.getUTCDate() - ((days || 1) - 1));
    setFilters((f) => ({
      ...f,
      from: days ? today.toISOString().slice(0, 10) : "",
      to: days ? to : "",
    }));
    setPage(0);
  };
  return (
    <div className="metrics-page">
      <header className="metrics-heading">
        <div>
          <h1>Hiring metrics</h1>
          <p>Lead volume, candidate experience, and your current pipeline.</p>
        </div>
        {hasFilters && (
          <button
            onClick={() => {
              setFilters({ ...EMPTY_FILTERS });
              setPage(0);
            }}
          >
            <RotateCcw size={15} /> Reset filters
          </button>
        )}
      </header>
      <section className="metrics-filters" aria-label="Metrics filters">
        <div className="metrics-periods">
          <span>Date range</span>
          {[
            [7, "7 days"],
            [30, "30 days"],
            [90, "90 days"],
            [null, "All time"],
          ].map(([days, text]) => (
            <button key={text} onClick={() => preset(days as number | null)}>
              {text}
            </button>
          ))}
        </div>
        <div className="metrics-filter-grid">
          <label className="metrics-field">
            From
            <input
              type="date"
              value={filters.from}
              onChange={(e) => update("from", e.target.value)}
            />
          </label>
          <label className="metrics-field">
            To
            <input
              type="date"
              value={filters.to}
              onChange={(e) => update("to", e.target.value)}
            />
          </label>
          <label className="metrics-field">
            Date basis
            <select
              value={filters.dateBasis}
              onChange={(e) => update("dateBasis", e.target.value)}
            >
              <option value="applied">Application date</option>
              <option value="added">Added to HireFlow</option>
            </select>
          </label>
          {select(
            "Experience",
            "experience",
            options((c) => c.experience),
          )}
          {select(
            "Role",
            "role",
            options((c) => c.job_title),
          )}
          {select(
            "Source",
            "source",
            options((c) => c.source),
          )}
          <label className="metrics-field">
            Current stage
            <select
              value={filters.stage}
              onChange={(e) => update("stage", e.target.value)}
            >
              <option value="">All</option>
              {data.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {select(
            "Applicant type",
            "applicantType",
            options((c) => c.attributes["Applicant Type"]),
          )}
          {select(
            "Spreadsheet decision",
            "decision",
            options((c) => c.attributes.Decision),
          )}
        </div>
        {invalidRange && (
          <p className="error" role="alert">
            Choose an end date on or after the start date.
          </p>
        )}
        <p className="metrics-caption">
          {filters.dateBasis === "applied"
            ? "Uses original application dates where supplied; otherwise intake date for new leads. Dates follow the source calendar day."
            : "Uses the UTC date each record was added to HireFlow, including bulk imports."}
          {unknownDates > 0 &&
            ` ${unknownDates} records have no valid date and are excluded when a date filter is set.`}
        </p>
      </section>
      <div className="metrics-summary" aria-live="polite">
        {[
          ["Applications", filtered.length, "Matching application records"],
          ["Unique contacts", unique, "By email, then phone if no email"],
          [
            "Repeat applications",
            filtered.length - unique,
            "Records sharing the same contact key",
          ],
          [
            "Currently hired",
            hired,
            `${filtered.length ? ((hired / filtered.length) * 100).toFixed(1) : 0}% of matching applications`,
          ],
        ].map(([title, value, caption]) => (
          <section key={title} className="metrics-stat">
            <span>{title}</span>
            <strong>{format.format(Number(value))}</strong>
            <small>{caption}</small>
          </section>
        ))}
      </div>
      <div className="metrics-charts">
        <section className="metrics-panel metrics-volume">
          <div className="metrics-panel-heading">
            <h2>Applications over time</h2>
            <span>
              {series.unit === "day"
                ? "Daily"
                : series.unit === "week"
                  ? "Weekly · Monday start"
                  : "Monthly"}
            </span>
          </div>
          {series.points.length ? (
            <>
              <div
                className="metrics-trend"
                role="img"
                aria-label={`Application volume by ${series.unit}. Exact counts are available in the table below.`}
              >
                {series.points.map((p) => (
                  <div
                    className="metrics-trend-column"
                    key={p.date}
                    title={`${p.date}: ${p.count} applications`}
                  >
                    <span style={{ height: `${(p.count / max) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div className="metrics-axis">
                <span>{shortDate(series.points[0].date)}</span>
                <span>{shortDate(series.points.at(-1)!.date)}</span>
              </div>
              <details className="metrics-volume-table">
                <summary>View exact counts</summary>
                <div>
                  <table>
                    <thead>
                      <tr>
                        <th>Period starting</th>
                        <th>Applications</th>
                      </tr>
                    </thead>
                    <tbody>
                      {series.points.map((p) => (
                        <tr key={p.date}>
                          <td>{p.date}</td>
                          <td>{p.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <p className="metrics-empty">
              No dated applications in this range.
            </p>
          )}
        </section>
        <Bars
          title="Experience"
          rows={breakdown(filtered, (c) => c.experience)}
          total={filtered.length}
          onChoose={(r) => update("experience", r.name)}
        />
        <Bars
          title="Current hiring stages"
          rows={stages}
          total={filtered.length}
          onChoose={(r) => update("stage", r.id!)}
          description="Where these applications are now, not a historical conversion funnel."
        />
        <Bars
          title="Roles"
          rows={breakdown(filtered, (c) => c.job_title)}
          total={filtered.length}
          onChoose={(r) => update("role", r.name)}
        />
        <Bars
          title="Sources"
          rows={breakdown(filtered, (c) => c.source)}
          total={filtered.length}
          onChoose={(r) => update("source", r.name)}
          description="Intake source; imported sheet records do not identify the original ad campaign."
        />
        <Bars
          title="Spreadsheet decisions"
          rows={breakdown(filtered, (c) => c.attributes.Decision)}
          total={filtered.length}
          onChoose={(r) => update("decision", r.name)}
          description={
            decisions
              ? "Historical review decisions are separate from current hiring stages."
              : "No historical decisions have been imported."
          }
        />
      </div>
      <section className="metrics-panel">
        <div className="metrics-panel-heading">
          <h2>Matching applications</h2>
          <span>{format.format(filtered.length)} records</span>
        </div>
        {filtered.length ? (
          <>
            <div className="metrics-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>
                      {filters.dateBasis === "applied" ? "Applied" : "Added"}
                    </th>
                    <th>Experience</th>
                    <th>Role</th>
                    <th>Current stage</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(safePage * 20, (safePage + 1) * 20).map((c) => (
                    <tr key={c.id}>
                      <td>
                        <button
                          className="metrics-candidate"
                          onClick={() => onCandidate(c)}
                        >
                          {c.name}
                          <ArrowUpRight size={14} />
                        </button>
                      </td>
                      <td>{candidateDay(c, filters.dateBasis) || "Unknown"}</td>
                      <td>{label(c.experience)}</td>
                      <td>{label(c.job_title)}</td>
                      <td>
                        {data.stages.find((s) => s.id === c.stage_id)?.name ||
                          "Unknown"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="metrics-pagination">
              <span>
                Page {safePage + 1} of {pages}
              </span>
              <button
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                Previous
              </button>
              <button
                disabled={safePage + 1 >= pages}
                onClick={() => setPage(safePage + 1)}
              >
                Next
              </button>
            </footer>
          </>
        ) : (
          <p className="metrics-empty">
            No applications match these filters. Adjust the filters or reset
            them.
          </p>
        )}
      </section>
    </div>
  );
}
