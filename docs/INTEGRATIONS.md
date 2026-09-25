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

## Google Workspace

Each company connects one Google Workspace account in **Settings → Google Workspace**, typically its hiring inbox. That single account powers email import, interview scheduling and recordings:

- **Email:** incoming and sent messages are imported into Chat.
- **Interviews:** the Calendar view creates Google Calendar events with a Meet link on the account's calendar and invites the candidate and selected teammates.
- **Recordings:** Meet saves recordings to the account's Drive, and HireFlow copies each one into private storage so every enabled member of the company can watch it, in any browser, without Drive sharing.

The account must be a Google Workspace user whose edition allows Meet recording (for example Business Standard), with recording allowed by the administrator. Personal Google accounts are rejected. HireFlow reads email but never sends it.

### Server setup

1. Create a dedicated Google Cloud project and configure Google Auth Platform. Enable the Gmail API, Google Calendar API, Google Meet REST API and Google Drive API. Create an OAuth client of type **Web application** with the exact redirect URI `https://YOUR_APP_HOST/api/google/callback`.
2. Add these scopes to the consent screen: `openid`, `email`, `gmail.readonly`, `calendar.events.owned`, `meetings.space.readonly`, `meetings.space.settings` and `drive.meet.readonly` (read-only access to files Meet created). `gmail.readonly` and `drive.meet.readonly` are restricted scopes. With an **Internal** audience no Google review is needed, which suits a deployment used only by its own Workspace organization. An External audience requires Google verification (and possibly a security assessment) before public use; apps left in Testing get seven-day refresh grants, so do not treat Testing as a permanent connection.
3. Set server-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_KEY` (a cryptographically random 32-byte key encoded as base64), and `CRON_SECRET` (a separate random secret). Set `APP_URL` to the canonical deployment origin. Keep the encryption key stable across deployments; replacing it makes saved grants unreadable and requires reconnection.
4. Apply migrations, including the private `hf-mail-attachments` and `hf-recordings` buckets and the server-only connection tables. Do not add public storage policies.
5. Deploy. `vercel.json` schedules `/api/cron/gmail`, `/api/cron/meet` and `/api/cron/recordings` every five minutes; this requires a Vercel plan that supports that frequency and function duration. For other hosting, call each endpoint with `Authorization: Bearer <CRON_SECRET>` from your scheduler.
6. An admin clicks **Connect Google** and chooses the account on Google's consent screen. The connected address is shown afterwards, and the first email import and calendar sync start immediately.

Refresh credentials are encrypted with AES-256-GCM, stored in one server-only row per company and never returned to the browser. Connection changes require current enabled admin membership. Email import and calendar sync each use their own exclusive expiring lease, so one never blocks the other. Reconnecting the same account keeps the email import checkpoint; connecting a different account restarts the import for the new mailbox and makes it the organizer for new interviews immediately. Interviews sent from an earlier account keep their history and saved recordings but are no longer synced or edited from HireFlow; change them in that account's Google Calendar. Disconnect invalidates in-flight work, removes the event subscription and revokes the Google grant unless the same account is still connected to another company. Imported email, sessions and saved recordings remain.

### Email

Candidate matching uses normalized sender email for incoming messages and recipient emails for sent messages, within the connected company only. A unique candidate match is linked automatically; unknown or ambiguous matches appear as unassigned signals for manual linking. No candidates are created from arbitrary email. A first import pages through the mailbox; later runs use Gmail history for incremental updates. **Sync now** triggers an additional pass.

Attachments up to 25 MiB are stored privately and downloaded only after checking current enabled company membership. Email deletions in Gmail are not mirrored into HireFlow. Bodies are displayed as plain text (up to 100,000 characters); remote tracking images and active HTML are not rendered. Spam, trash and drafts are excluded.

Ordinary incoming mail matches the sender. To associate a trusted form-notification email with the applicant listed in its body, configure `GMAIL_APPLICATION_SENDERS` as a comma-separated list of exact notifier addresses. Only those senders can use a standalone `Email: applicant@example.com` line for matching. Leave this unset for general deployments unless that notifier format is intended. This setting applies across the deployment, so use notifier addresses that you control and trust.

### Interviews

Recording starts automatically only after the organizer joins from a web browser; HireFlow cannot start or stop recording. HireFlow enables automatic transcription and turns off Gemini notes when configuring the meeting. The candidate is never given recording access.

- Calendar titles include the candidate name, for example `Interview — Alex Example`, in HireFlow and Google Calendar. Existing upcoming Google events gain the name on their next sync without another guest invitation.
- Configure `SMTP_*` to send the connected account a separate confirmation after scheduling, edits and cancellations. It contains the candidate name, both dates/times, the scheduling time zone and the Meet link. Guest invitations still come from Google. Email failures appear in session details and retry on the scheduled sync; successful delivery is tracked per interview revision. SMTP delivery is at-least-once: a process failure after SMTP acceptance but before acknowledgement can cause a duplicate; retries keep the same Message-ID. Deployment does not send confirmations for already-synced historical revisions.
- Each session's scheduling is synced separately from its recording setup and from each recording (in progress, processing, available). Google deletes conference records 30 days after a meeting, so HireFlow saves recording details as soon as it sees them. The scheduled sync collects recordings until three days after each interview.
- Changes made directly in Google Calendar (time, title, cancellation) flow back into HireFlow. A HireFlow edit sends updated invitations. Google may ask guests to RSVP again after a time change; HireFlow shows Google's latest response.
- A queued change runs only while its author and every selected interviewer are still enabled members. Outcomes that belong to an older revision are discarded.

### Recording storage

Recordings are copied through the S3 protocol, so any S3-compatible store works. The database stores only object keys (`company/interview/recording.mp4`), never provider URLs, and playback links are issued only after checking current enabled membership. To use Supabase Storage:

1. In the Supabase dashboard, open **Storage → Settings**, enable the S3 connection, and create an access key.
2. Raise the **Global file size limit** above your longest expected recording (paid plans allow up to 500 GB).
3. Set server-only `RECORDING_STORAGE_ENDPOINT` (`https://PROJECT_REF.storage.supabase.co/storage/v1/s3`), `RECORDING_STORAGE_REGION` (the project's region, for example `ca-central-1`), `RECORDING_STORAGE_BUCKET=hf-recordings`, `RECORDING_STORAGE_ACCESS_KEY_ID` and `RECORDING_STORAGE_SECRET_ACCESS_KEY`.

`/api/cron/recordings` copies finished recordings from the organizer's Drive, streaming in 16 MB parts without buffering the whole video. Each recording is claimed for 20 minutes; failures are shown on the recording and retried up to five times. Deleting an interview, candidate or company queues its saved videos, and the same job deletes them from storage. Until a recording is saved, it plays from Drive for viewers whose Google account can open it. Without storage settings, recordings stay in Drive only.

To move to another provider such as Cloudflare R2, create a private bucket there, copy the objects with the same keys (for example with `rclone`), and change the five `RECORDING_STORAGE_*` settings. No database change is needed.

### Instant updates (optional)

Without this, new recordings and meeting start/end times appear within about five minutes. With it, Google notifies HireFlow as soon as a meeting starts or ends and as soon as a recording is ready.

1. Enable the Google Workspace Events API and Pub/Sub in the same project (Pub/Sub needs a billing account). Create a topic and grant `meet-api-event-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it.
2. Create a service account for push authentication. Create a push subscription on the topic with endpoint `https://YOUR_APP_HOST/api/meet/events`, authentication enabled with that service account, audience equal to the endpoint URL, and an acknowledgement deadline of 60 seconds.
3. Set `MEET_EVENTS_TOPIC=projects/PROJECT/topics/TOPIC` and `MEET_EVENTS_PUSH_ACCOUNT=<service account email>`, then reconnect Google or wait for the next sync. The Calendar view shows **Instant updates on** once Google confirms the subscription. HireFlow renews it before its seven-day expiry. The five-minute sync keeps running as the recovery path.

### Verification

Run `npm test` and `npm run typecheck`. `scripts/verify-meet.sql` checks tenant isolation, admin-only connection, membership rules, RSVP preservation, exclusive leases, stale-result rejection, recording ownership, recording copy claims, cancellation, account switching, email import checkpoints, past-session corrections, disabled members, disconnect invalidation and storage cleanup. It uses synthetic records inside a transaction that is rolled back; run it with `psql` or the Supabase SQL editor. Against a running local app, `APP_URL=http://localhost:3101 node --env-file=.env.local --import tsx scripts/verify-gmail.ts` verifies company isolation, disabled-member access, private resume downloads, matching, manual linking, duplicate imports and disconnect invalidation; it removes its own synthetic records and files. Before claiming the integration is live, connect the real account and check an email import, invitations, RSVP, a time change, a cancellation, and a short recorded call from start to playback by a second team member.
