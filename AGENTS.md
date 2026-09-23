# HireFlow

- HireFlow is an open-source project. Keep repository content suitable for public release.
- Build a complete, efficient hiring product. Do not over-engineer. Remove dead code, redundant or duplicate code, filler, unused abstractions, and dead UI.
- No AI agents or automated hiring decisions in the product.
- One account may join multiple companies. Every business record must be company-scoped. Enforce membership and enabled status in server queries and atomic database mutations, as well as the UI.
- Use a dedicated HireFlow Supabase project for PostgreSQL and authentication. Do not use Cloudflare or the shared Ottawa Painters database. Keep all business records scoped to a company.
- Preserve unrelated applications and data during infrastructure changes.
- Never commit credentials, personal information, applicant data, or private documents, including in `AGENTS.md`. Keep examples synthetic and integrations server-side.
- Verify access isolation, invitations, webhook retries, and the complete hiring flow before claiming completion.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
