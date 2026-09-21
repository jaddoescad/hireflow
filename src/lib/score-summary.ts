export function scoreSummary(
  candidate: { name: string; job_title: string },
  rows: { name: string; rating: number | null; note: string }[],
  unsaved: boolean,
) {
  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  const rated = rows.filter((row) => row.rating !== null);
  const average = rated.length
    ? `${(rated.reduce((sum, row) => sum + row.rating!, 0) / rated.length).toFixed(1)}/10`
    : "Not assessed";
  return [
    `${clean(candidate.name)}${candidate.job_title ? ` — ${clean(candidate.job_title)}` : ""}`,
    "• Voice interview assessment" + (unsaved ? " (includes unsaved changes)" : ""),
    `• Overall: ${average} (${rated.length}/${rows.length} assessed)`,
    ...rows.map((row) =>
      `• ${clean(row.name)}: ${row.rating === null ? "Not assessed" : `${row.rating}/10`}${clean(row.note) ? ` — ${clean(row.note)}` : ""}`,
    ),
  ].join("\n");
}
