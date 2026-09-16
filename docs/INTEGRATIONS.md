# Integrations

## Zapier intake

The existing active Zap is **Interior + Exterior Hiring | Facebook Leads → Hiring Sheet**. Preserve its Google Sheets step. The deployed Zap has a Webhooks by Zapier POST action after it, before delay/outbound communication actions. Use the same ordering when setting up another company.

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
| attributes.Led Crew Before | Crew Lead Experience / Led Crew Before |
| attributes.Transportation Answer | Transportation Answer |
| attributes.Start Availability | Start Availability |
| attributes.Hourly Pay Expectation | Hourly Pay Expectation |
| attributes.Applied at | Created Time |

Use a JSON array for `tags`, and a JSON object for `attributes`. Never generate a new source_id on retries. Intake creates an application in the first stage; a duplicate source/source_id returns the existing ID without resetting its stage or overwriting team edits. Phone numbers normalize to E.164, with Canada as the default region. When a valid email exists, invalid phone values are retained in the Original phone (needs review) attribute and tagged Phone needs review; they are never used for matching. Intake rejects applications without a valid email or phone. Email is trimmed and lowercased.

## Quo

Each company configures its own API key, phone ID, number, and webhook signing secrets in Settings. Secrets are only accessible to the server role, never returned to browsers. The Ottawa Painters production line is +13433265133, ID `PNHtOrvjNR`.

Subscribe `/api/webhooks/quo/<company-id>` to `message.received`, `message.delivered` and `call.completed` events for the company’s selected phone line. The handler supports Quo’s `data.object` payload. Signature verification follows Quo's HMAC-SHA256 specification: base64 signing secret, `<timestamp>.<compact JSON>`, `openphone-signature` header, five-minute tolerance, constant-time comparison. When Quo creates separate message and call webhooks, enter both signing secrets separated by commas.

The inbox displays only events whose external phone/email matches a hiring candidate in that company. Unrelated production-line customer calls are ignored. Shared contact identifiers produce an unassigned signal for manual matching. Group conversations are ignored. Event IDs are deduplicated. Candidate detail → Sync history pulls that candidate's existing one-to-one calls and messages from Quo v1.

## Invitation email

Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM on the server. Invitations are created before delivery and remain usable if SMTP fails; the admin receives an explicit delivery failure and a copyable link. Links expire after seven days, can be revoked, and only the invited verified email can accept them. Existing users keep one account across all companies.

Configure Supabase Auth's email provider separately for account confirmation and passwordless login. Add the deployed app's `/auth/callback` and `/auth/callback?invite=*` URLs to the dedicated HireFlow project's redirect allowlist. The browser stores a pending invitation token for the current tab and includes it in the email callback so opening the email in a new tab preserves the invitation.

## Gmail

Each company admin can connect one Gmail or Google Workspace mailbox in Settings → Gmail. Incoming and sent messages are imported into Chat. Candidate matching uses normalized sender email for incoming messages and recipient emails for sent messages, within the connected company only. A unique candidate match is linked automatically; unknown or ambiguous matches appear as unassigned signals for manual linking. No candidates are created from arbitrary email. Gmail sending is not part of this integration.

### Server setup

1. Create a dedicated Google Cloud project, enable the Gmail API, and configure Google Auth Platform. Create an OAuth client of type **Web application** with the exact redirect URI `https://YOUR_APP_HOST/api/gmail/callback`.
2. Request only `https://www.googleapis.com/auth/gmail.readonly`. Configure your app's audience, support contact and privacy policy in Google. External apps using Gmail's restricted scope may require Google verification and a security assessment before public distribution. External apps left in Testing have short-lived refresh grants (normally seven days); do not treat Testing as a permanent production connection. An Internal audience is only suitable for a deployment restricted to its own Google Workspace organization.
3. Set server-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_KEY` (a cryptographically random 32-byte key encoded as base64), and `CRON_SECRET` (a separate random secret). Set `APP_URL` to the canonical deployment origin. Keep the encryption key stable across deployments; replacing it makes saved mailbox grants unreadable and requires reconnection.
4. Apply migrations, including the private `hf-mail-attachments` bucket and server-only connection table. Do not add public storage policies.
5. Deploy. `vercel.json` schedules `/api/cron/gmail` every five minutes; this requires a Vercel plan that supports that frequency. For other hosting, invoke that endpoint with `Authorization: Bearer <CRON_SECRET>` using your scheduler.
6. In the company settings, connect the intended mailbox using Google's consent screen. The connected mailbox address is shown after authorization. A first import starts immediately; background runs continue paginated imports and then use Gmail history for incremental updates. **Sync now** triggers an additional pass.

Refresh credentials are encrypted with AES-256-GCM and never returned to the browser. Connection changes require current enabled admin membership. Imports use an exclusive expiring lease and message IDs for retry safety. Disconnect invalidates an in-flight import and deletes this company's stored grant; it does not revoke a Google grant used by another company's connection. To revoke the app globally, remove its access in the Google Account's third-party connections settings.

Attachments up to 25 MiB are stored privately and downloaded only after checking current enabled company membership. Disconnect retains imported messages and resumes. Email deletions in Gmail are not mirrored into HireFlow. Bodies are displayed as plain text (up to 100,000 characters); remote tracking images and active HTML are not rendered. Spam, trash and drafts are excluded.

### Application notification emails

Ordinary incoming mail matches the sender. To associate a trusted form-notification email with the applicant listed in its body, configure `GMAIL_APPLICATION_SENDERS` as a comma-separated list of exact notifier addresses. Only those senders can use a standalone `Email: applicant@example.com` line for matching. Leave this unset for general deployments unless that notifier format is intended. This setting applies across the deployment, so use notifier addresses that you control and trust.

### Verification

Run `npm test` and `npm run typecheck`. Against a running local app, use `APP_URL=http://localhost:3101 node --env-file=.env.local --import tsx scripts/verify-gmail.ts` to verify synthetic company isolation, disabled-member access, admin-only connections, private resume downloads, automatic matching, manual linking, duplicate imports, exclusive leases and disconnect invalidation. The script removes its own synthetic records and files. Complete a real OAuth connection and confirm mailbox imports and scheduled runs before claiming the integration is live.
