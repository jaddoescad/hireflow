# HireFlow

- Build a complete, efficient hiring product. Do not over-engineer. Remove filler, duplicate code, unused abstractions, and dead UI.
- No AI agents or automated hiring decisions in the product.
- Before designing or redesigning UI, generate a UI image with Codex's built-in GPT image generation model. Save the image and prompt in `docs/design/`, inspect it, and use it as implementation inspiration. Do not copy Hermes CRM's UI.
- One account may join multiple companies. Every business record must be company-scoped. Enforce membership and enabled status in the database as well as the UI.
- Keep Ottawa Painters' existing tables and applications intact. Prefix HireFlow tables with `hf_`.
- Never commit credentials or applicant data. Keep examples synthetic and integrations server-side.
- Verify access isolation, invitations, webhook retries, and the complete hiring flow before claiming completion.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
