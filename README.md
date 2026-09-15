# HireFlow

A multi-company hiring CRM built with Next.js, TypeScript, and Supabase. Manage applications through your hiring stages and keep Quo calls, text messages, and team notes beside each candidate.

## Features

- Email/password and passwordless authentication.
- One account across multiple companies, with a company chooser and sidebar switcher.
- Admin/member roles, expiring email invitations, and per-company enable/disable controls.
- Hiring board with configurable stages, drag-and-drop and accessible stage selection.
- Candidate profiles, job and experience filters, tags, notes, and communication signals.
- Authenticated, idempotent Zapier intake and signed Quo webhooks.
- No AI agents or automated hiring decisions.

## Run locally

Requires Node.js 22+ and a Supabase project.

```sh
npm ci
cp .env.example .env.local
# Fill the environment variables using your project's API settings.
npm run dev
```

Open http://localhost:3100. Never prefix the service-role key or SMTP credentials with `NEXT_PUBLIC_`.

Apply every SQL file in `supabase/migrations` in filename order using the Supabase CLI or dashboard. The migrations create `hf_` tables alongside existing applications. They enable row-level security and grant client read access only to enabled company members. Server mutations are serialized by company and verify current membership. Only the server role can invoke mutation/ingestion RPCs or read integration secrets and invitation tokens.

Configure Auth email delivery in Supabase. Add `http://localhost:3100/auth/callback` and `http://localhost:3100/auth/callback?invite=*` to its redirect allowlist. Create your account, confirm your email, create a company, then invite teammates. Configure SMTP environment variables for invitation email delivery. A copyable invitation link is available if delivery is unavailable.

The historical sheet importer runs in dry-run mode by default:

```sh
node --env-file=.env.local --import tsx scripts/import-hiring-sheet.ts values.json COMPANY_UUID
# Add --apply only after reviewing the dry-run result.
```

See [integration setup](docs/INTEGRATIONS.md) for Zapier mapping and Quo configuration.

## Deploy on Vercel

Import this repository as a Next.js project. Set the environment variables from `.env.example`, with `APP_URL` set to the canonical HTTPS deployment URL. Deploy, add its `/auth/callback` and `/auth/callback?invite=*` URLs to Supabase Auth, then configure webhooks using the production URL. Do not point production integrations at a temporary preview.

## Verification

The GitHub Actions workflow runs unit tests, TypeScript checks, and a production build on pull requests and pushes to `main`. It requires no secrets or live database. Run the separate integration scripts against your own configured project to verify database permissions and server behavior.

```sh
npm test
npm run typecheck
npm run build
# Against the running app:
node --env-file=.env.local --import tsx scripts/verify-http.ts
# Uses a configured database. Creates and removes only synthetic verification users/companies.
node --env-file=.env.local --import tsx scripts/verify-database.ts
```

Database verification covers tenant isolation, forbidden client writes, secret visibility, cross-company references, invitation identity, shared-email memberships, immediate disable, concurrent last-admin protection, stage changes, notes, duplicate intake, communication isolation, and ambiguous matching.

## Contributing

Keep changes focused. Read [AGENTS.md](AGENTS.md) and [product scope](docs/PRODUCT.md). Generate and inspect UI inspiration before designing new screens. Keep secrets and real applicant information out of fixtures, screenshots, and commits. Use migrations for schema changes and test permissions whenever access behavior changes.

## License

MIT. See [LICENSE](LICENSE).
