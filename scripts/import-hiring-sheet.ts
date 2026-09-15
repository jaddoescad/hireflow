import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { mapHiringRow } from "../src/lib/import-mapping";
// Input: a Google Sheets values response saved as JSON, with the header row first.
// Dry-run is the default. No row-level personal information is logged.
const [file, companyId, flag] = process.argv.slice(2);
if (!file || !companyId)
  throw new Error(
    "Usage: node --env-file=.env.local --import tsx scripts/import-hiring-sheet.ts <values.json> <company-uuid> [--apply]",
  );
z.uuid().parse(companyId);
if (flag && flag !== "--apply") throw new Error("Only --apply is supported");
const input = JSON.parse(readFileSync(file, "utf8"));
const values = input.values as unknown[][];
if (!Array.isArray(values) || values.length < 1)
  throw new Error(
    "Expected {values: [[headers], [row], ...], spreadsheetId?: string}",
  );
const headers = values[0].map(String);
if (!headers.includes("Full Name") || !headers.includes("Phone Number"))
  throw new Error("This is not the Hiring Sheet schema");
const valid = [];
const rejected: { row: number; reason: string }[] = [];
for (let i = 1; i < values.length; i++) {
  try {
    const item = mapHiringRow(
      headers,
      values[i],
      input.spreadsheetId || "Hiring Sheet",
      i + 1,
    );
    if (item) valid.push(item);
  } catch {
    rejected.push({
      row: i + 1,
      reason:
        "Invalid name, email, phone, or field length. Correct the source row before importing.",
    });
  }
}
console.log(
  JSON.stringify({
    mode: flag === "--apply" ? "apply" : "dry-run",
    valid: valid.length,
    rejected: rejected.length,
  }),
);
if (rejected.length) {
  mkdirSync("tmp", { recursive: true });
  writeFileSync(
    "tmp/import-rejections.json",
    JSON.stringify(rejected, null, 2),
  );
  throw new Error(
    "Source rows need correction. Review tmp/import-rejections.json; no records were written.",
  );
}
if (flag === "--apply") {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await db
    .from("hf_companies")
    .select("id")
    .eq("id", companyId)
    .single();
  if (error || !data) throw new Error("Company does not exist");
  let added = 0,
    duplicates = 0;
  for (const payload of valid) {
    const { data, error } = await db.rpc("hf_ingest", {
      cid: companyId,
      event_kind: "intake",
      payload,
    });
    if (error)
      throw new Error(
        `Import stopped after ${added + duplicates} rows: ${error.message}. It is safe to retry.`,
      );
    if (data.duplicate) duplicates++;
    else added++;
  }
  console.log(JSON.stringify({ added, duplicates }));
}
