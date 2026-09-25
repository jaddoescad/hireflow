# HireFlow

**A hiring workspace for teams that want a clear pipeline and all candidate conversations in one place.**

HireFlow brings applications, interview stages, notes, calls, texts, emails, and resumes together. One account can work across multiple companies, with separate candidates, settings, and team permissions for each.

[Open HireFlow](https://hireflow-theta-seven.vercel.app) · [Integration guide](docs/INTEGRATIONS.md) · [Report an issue](https://github.com/jaddoescad/hireflow/issues)

The hosted app requires sign-in. Create your own company or accept an invitation to an existing one; a public source repository does not grant access to another company's applicants.

## What you can do

- **Manage a hiring pipeline:** create candidates, customize stages, move cards with drag-and-drop or a stage selector, and search/filter by role, experience, or tags.
- **Understand your hiring pipeline:** filter lead volume by date, experience, role, source, stage, and imported decisions; inspect stage counts and open matching applications. See [metric definitions](docs/METRICS.md).
- **Keep context beside the candidate:** add team notes, review Quo calls/texts, Gmail conversations, private resume attachments, and interview recordings saved for the whole team.
- **Rate voice interviews:** use one shared 0–10 scorecard for all positions in each company. Admins add, edit, and remove categories in Settings. Candidate cards show a compact colored average; open Scores to enter ratings and notes.
- **Work across companies:** switch workspaces without separate accounts. Admins manage invitations, roles, and enabled membership per company.
- **Connect application sources:** accept authenticated Zapier/webhook submissions with stable IDs so retries do not create duplicate applications.
- **Make your own hiring decisions:** no AI agents, automated scoring, or automated hiring decisions.

## Stack and structure

Next.js 16 App Router, React 19, TypeScript, and a dedicated Supabase project for PostgreSQL, authentication, and private attachment storage. The hosted app runs on Vercel.

| Path | Purpose |
| --- | --- |
| `src/app` | Application pages, authentication callbacks, and server API routes |
| `src/components` | Hiring board, candidate conversations, team, and settings UI |
| `src/lib` | Validation, company access, integration clients, and shared logic |
| `supabase/migrations` | Versioned database schema, permissions, and atomic mutations |
| `supabase/templates` | Authentication email template |
| `scripts` | Historical importer and live verification scripts |
| `tests` | Unit tests using synthetic fixtures |
| `docs` | Integration documentation and generated design references |

## Run locally

You need Node.js 22+, npm, and your own dedicated Supabase project. Never use another application's production database for a new installation.

```sh
git clone https://github.com/jaddoescad/hireflow.git
cd hireflow
npm ci
cp .env.example .env.local
```

1. Apply the SQL files in `supabase/migrations` in filename order to your Supabase project, using the Supabase CLI or SQL editor.
2. Fill in `.env.local` using your project's API settings. The minimum configuration is:

   | Variable | Purpose |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Server-only database credential |
   | `APP_URL` | Canonical app origin; `http://localhost:3100` for local development |

3. Configure email delivery in Supabase Auth. Use `supabase/templates/magic-link.html` for email sign-in links and one-time codes. Enable leaked-password protection. Add `http://localhost:3100/auth/callback` and `http://localhost:3100/auth/callback?invite=*` to the redirect allowlist.
4. Start the app:

   ```sh
   npm run dev
   ```

5. Open [localhost:3100](http://localhost:3100), create and verify your account, then create a company. Add a candidate, move them through your stages, and invite a teammate.

Optional SMTP variables enable invitation delivery. Supabase Auth email delivery is configured separately. If invitation delivery is unavailable, admins can copy the invitation link.

## Integrations

The core hiring workspace works without connecting external services.

| Integration | What it adds | Setup |
| --- | --- | --- |
| Zapier / webhooks | Company-scoped application intake with retry deduplication | Generate an intake token in Integrations; POST to `/api/webhooks/intake` |
| Quo | Candidate call and SMS history; signed webhook updates | Configure the company's API key, phone line, and signing secrets in Integrations |
| Google Workspace | One account per company: read-only email sync with private resume attachments, Calendar/Meet interviews, and recordings copied to private storage for the team | Configure Google OAuth, server encryption and recording storage, then connect the account in Integrations |
| SMTP | Team invitation emails and interview organizer confirmations | Set the `SMTP_*` server environment variables |

See [the integration guide](docs/INTEGRATIONS.md) for payload mapping, callback URLs, secrets, and verification commands. HireFlow imports email; it does not send it. Ambiguous conversation matches remain unassigned for manual review.

The current hosted Google OAuth app is restricted to its configured Google Workspace organization. Other organizations need their own OAuth configuration or an appropriately configured and verified external Google app. This restriction does not prevent using HireFlow's core hiring workspace.

For historical imports, keep source files outside Git. The importer defaults to a dry run:

```sh
node --env-file=.env.local --import tsx scripts/import-hiring-sheet.ts /path/to/values.json COMPANY_UUID
# Add --apply only after reviewing the dry-run result.
```

## Deploy your own instance

Apply new database migrations before deploying the matching application update. The interview scorecard migration seeds the default categories for existing companies and new company creation.

1. Fork or clone this repository and import it into Vercel as a **Next.js** project, using the repository root.
2. Configure your dedicated Supabase project and apply the migrations.
3. Set the environment variables from `.env.example` in Vercel. Use your canonical HTTPS origin for `APP_URL`. Keep service credentials, SMTP passwords, OAuth secrets, and encryption keys server-side.
4. Deploy and add the production `/auth/callback` and `/auth/callback?invite=*` URLs to Supabase Auth. If using Google Workspace, register the exact `/api/google/callback` URL in Google OAuth.
5. Point integrations at your stable production URL and run the live verification scripts below.

`vercel.json` includes five-minute email, calendar and recording crons. Use a Vercel plan that supports this frequency, or remove the cron entries and configure an external scheduler to call `/api/cron/gmail`, `/api/cron/meet` and `/api/cron/recordings` with `Authorization: Bearer <CRON_SECRET>`. Keep `GMAIL_TOKEN_KEY` stable across deployments so existing Google credentials remain readable.

## Verification

Interview scores are entered by your team. Card averages give equal weight to assessed, active categories; unassessed and removed categories are excluded. Green means 4–5, amber 3–3.9, red below 3, and a gray dash means unscored. Hover over a badge for the rating count. Removing a category preserves its existing ratings under Removed categories. Conflicting edits require a reload before saving.

```sh
npm test
npm run typecheck
npm run build
```

On an isolated development database with all migrations applied, the scorecard SQL regression checks cover company isolation, disabled memberships, server-only writes, averages, edit conflicts, removed-category history, invitations, hiring stages, and intake/call retries. Fixtures are synthetic and rolled back:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/scorecard.sql
```

GitHub Actions runs these checks on pull requests and pushes to `main`, without production secrets or a live database.

To verify a configured instance, start it first and set `APP_URL` to that instance:

```sh
node --env-file=.env.local --import tsx scripts/verify-database.ts
node --env-file=.env.local --import tsx scripts/verify-http.ts
node --env-file=.env.local --import tsx scripts/verify-gmail.ts
```

Live checks create and remove their own synthetic users and companies. They cover company isolation, forbidden client writes, disabled membership, invitation identity and retries, concurrent last-admin protection, hiring actions, duplicate intake, signed webhook retries, conversation matching, and private attachment access.

## Security and data boundaries

Business records belong to a company. Database row-level security and server mutations check current enabled membership; privileged operations require an admin. Integration credentials and invitation tokens remain server-only, and resume downloads require company access.

Never commit `.env.local`, credentials, applicant exports, resumes, or screenshots containing real candidate information. Use synthetic fixtures for development and testing. Do not submit sensitive records or secrets in public issues.

## Contributing

Keep changes focused and follow [AGENTS.md](AGENTS.md). Include migrations for schema changes and permission checks for access changes. Generate and inspect a visual reference before designing new UI. Run the relevant verification commands before opening a pull request.

## License

[MIT](LICENSE).
