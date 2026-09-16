# HireFlow

- Build a complete, efficient hiring product. Do not over-engineer. Remove filler, duplicate code, unused abstractions, and dead UI.
- No AI agents or automated hiring decisions in the product.
- Before designing or redesigning UI, generate a UI image with Codex's built-in GPT image generation model. Save the image and prompt in `docs/design/`, inspect it, and use it as implementation inspiration. Do not copy Hermes CRM's UI.
- One account may join multiple companies. Every business record must be company-scoped. Enforce membership and enabled status in server queries and atomic database mutations, as well as the UI.
- Use a dedicated HireFlow Supabase project for PostgreSQL and authentication. Do not use Cloudflare or the shared Ottawa Painters database. Keep all business records scoped to a company.
- Preserve unrelated applications and data during infrastructure changes.
- Never commit credentials or applicant data. Keep examples synthetic and integrations server-side.
- Verify access isolation, invitations, webhook retries, and the complete hiring flow before claiming completion.
