# Hiring metrics

Open **Metrics** in a company workspace. All totals and candidate drill-downs use that company's existing authorized workspace response; no new privileged reporting endpoint is exposed.

Filters combine: date range, date basis, experience, role, intake source, current stage, applicant type, and historical spreadsheet decision. Clicking a breakdown row applies its filter. Reset restores all-time, unfiltered application-date reporting. The matching applications table opens the existing candidate profile and paginates by 20 records.

## Definitions

- **Applications:** matching records, including repeat submissions.
The Applications card shows repeat submissions in its caption instead of separate contact-count cards.

- **Contact counting:** distinct trimmed, lowercased email addresses; phone is used when email is absent, otherwise the record ID. This is not verified identity deduplication, and does not merge or delete records.
- **Repeat applications note:** applications minus unique contact keys.
- **Currently hired:** matching records in stages named Hired, with their share of the filtered records. This is a current-state share, not historical conversion.
- **Application date:** the original `Applied at` calendar date when provided. New non-sheet leads without that field use their intake date. Historical sheet records without a valid date remain undated; they are counted in all-time totals but excluded by date filters and the trend.
- **Added to HireFlow:** record creation date in UTC, including bulk imports.
- **Volume:** daily buckets through 45 days, Monday-start weeks through 180 days, and monthly buckets beyond that. Zero periods are retained. Exact counts are available below the chart.
- **Stages:** current positions of the filtered applications. No unrecorded past stage visits or funnel conversions are inferred.
- **Sources:** intake provenance. Hiring Sheet does not establish the original advertising campaign.
- **Spreadsheet decisions:** imported review labels, separate from current stage. Metrics do not automatically move rejected or deferred applications.

Only date strings beginning with a valid ISO calendar date are interpreted. Ambiguous date strings are left unknown rather than guessed. Application calendar days are preserved from their source; added dates use UTC.

The existing deferred stage in the configured company was renamed from Contact later to Saved for later through the authorized stage mutation. Its ID, order, and candidate assignments were preserved. Other companies' stages were not changed.
