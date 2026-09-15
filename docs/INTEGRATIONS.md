# Integrations

## Zapier intake

The existing active Zap is **Interior + Exterior Hiring | Facebook Leads → Hiring Sheet**. Preserve its Google Sheets step. Add a Webhooks by Zapier POST action after it, before delay/outbound communication actions.

POST `/api/webhooks/intake` with JSON and `Authorization: Bearer <company intake token>`. Generate the token in Settings. This token is company-specific; only its SHA-256 hash is stored. Rotating it invalidates the old token immediately.

| HireFlow field | Existing Meta / Sheet field |
| --- | --- |
| source_id | Meta lead ID (stable across retries) |
| name | Full Name |
| email | Email |
| phone | Phone Number |
| experience | Painting Experience / Years Painting Experience |
| job_title | Best Fit Position / Position Applied For |
| tags | Applicant Type; useful labels derived from crew leadership and transportation |
| attributes.crew_lead | Crew Lead Experience / Led Crew Before |
| attributes.transportation | Transportation Answer |
| attributes.availability | Start Availability |
| attributes.pay_expectation | Hourly Pay Expectation |
| attributes.applied_at | Created Time |

Use a JSON array for `tags`, and a JSON object for `attributes`. Never generate a new source_id on retries. Intake creates an application in the first stage; a duplicate source/source_id returns the existing ID without resetting its stage or overwriting team edits. Phone numbers normalize to E.164, with Canada as the default region. Invalid phones are rejected rather than matched loosely. Email is trimmed and lowercased.

## Quo

Each company configures its own API key, phone ID, number, and webhook signing secrets in Settings. Secrets are only accessible to the server role, never returned to browsers. The Ottawa Painters production line is +13433265133, ID `PNHtOrvjNR`.

Subscribe `/api/webhooks/quo/<company-id>` to legacy v1 `message.received`, `message.delivered` and `call.completed` events. The handler currently supports the v1 `data.object` payload. Signature verification follows Quo's HMAC-SHA256 specification: base64 signing secret, `<timestamp>.<compact JSON>`, `openphone-signature` header, five-minute tolerance, constant-time comparison. When Quo creates separate message and call webhooks, enter both signing secrets separated by commas.

The inbox displays only events whose external phone/email matches a hiring candidate in that company. Unrelated production-line customer calls are ignored. Shared contact identifiers produce an unassigned signal for manual matching. Group conversations are ignored. Event IDs are deduplicated. Candidate detail → Sync history pulls that candidate's existing one-to-one calls and messages from Quo v1.

## Invitation email

Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM on the server. Invitations are created before delivery and remain usable if SMTP fails; the admin receives an explicit delivery failure and a copyable link. Links expire after seven days, can be revoked, and only the invited verified email can accept them. Existing users keep one account across all companies.

Configure Supabase Auth's email provider separately for account confirmation and passwordless login. Add the deployed app's `/auth/callback` URL to the existing project's redirect allowlist without removing other applications' URLs. The browser stores a pending invitation token for the current tab before beginning login.
