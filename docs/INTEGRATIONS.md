# Integrations

## Zapier intake

The existing active Zap is **Interior + Exterior Hiring | Facebook Leads → Hiring Sheet**. Preserve its Google Sheets step. The deployed Zap has a Webhooks by Zapier POST action after it, before delay/outbound communication actions. Use the same ordering when setting up another company.

POST `/api/webhooks/intake` with JSON and `Authorization: Bearer <company intake token>`. Generate the token in Integrations. This token is company-specific; only its SHA-256 hash is stored. Rotating it invalidates the old token immediately.

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

Each company configures its own API key, phone ID, number, and webhook signing secrets in Integrations. Secrets are only accessible to the server role, never returned to browsers.

Subscribe `/api/webhooks/quo/<company-id>` to `message.received`, `message.delivered` and `call.completed` events for the company’s selected phone line. The handler supports Quo’s `data.object` payload. Signature verification follows Quo's HMAC-SHA256 specification: base64 signing secret, `<timestamp>.<compact JSON>`, `openphone-signature` header, five-minute tolerance, constant-time comparison. When Quo creates separate message and call webhooks, enter both signing secrets separated by commas.

The inbox displays only events whose external phone/email matches a hiring candidate in that company. Unrelated production-line customer calls are ignored. Shared contact identifiers produce an unassigned signal for manual matching. Group conversations are ignored. Event IDs are deduplicated. Candidate detail → Sync history pulls that candidate's existing one-to-one calls and messages from Quo v1.

## Invitation email

Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM on the server. Invitations are created before delivery and remain usable if SMTP fails; the admin receives an explicit delivery failure and a copyable link. Links expire after seven days, can be revoked, and only the invited verified email can accept them. Existing users keep one account across all companies.

Configure Supabase Auth's email provider separately for account confirmation and passwordless login. Add the deployed app's `/auth/callback` and `/auth/callback?invite=*` URLs to the dedicated HireFlow project's redirect allowlist. The browser stores a pending invitation token for the current tab and includes it in the email callback so opening the email in a new tab preserves the invitation.

## Google Workspace

Each company connects one Google Workspace account in **Integrations → Google Workspace** (or from the Calendar page), typically its hiring inbox. That single account powers email import and interview scheduling:

- **Email:** incoming and sent messages are imported into Chat.
- **Interviews:** HireFlow creates a Meet room for each interview, then a Google Calendar event on the account's calendar that invites the candidate and selected teammates with the room's link.

Automatic recording is disconnected; see [Interview recording](#interview-recording).

The account must be a Google Workspace user whose edition supports Meet co-hosts and host management (for example Business Standard). Personal Google accounts are rejected. HireFlow reads email but never sends it.

### Server setup

1. Create a dedicated Google Cloud project and configure Google Auth Platform. Enable the Gmail API, Google Calendar API and Google Meet REST API. Create an OAuth client of type **Web application** with the exact redirect URI `https://YOUR_APP_HOST/api/google/callback`.
2. Add these scopes to the consent screen: `openid`, `email`, `gmail.readonly`, `calendar.events.owned`, `meetings.space.created` (create interview rooms and add co-hosts) and `meetings.space.readonly` (see when meetings start and end). `gmail.readonly` is a restricted scope. With an **Internal** audience no Google review is needed, which suits a deployment used only by its own Workspace organization. An External audience requires Google verification (and possibly a security assessment) before public use; apps left in Testing get seven-day refresh grants, so do not treat Testing as a permanent connection.
3. Set server-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_KEY` (a cryptographically random 32-byte key encoded as base64), and `CRON_SECRET` (a separate random secret). Set `APP_URL` to the canonical deployment origin. Keep the encryption key stable across deployments; replacing it makes saved grants unreadable and requires reconnection.
4. Apply migrations, including the private `hf-mail-attachments` and `hf-recordings` buckets and the server-only connection tables. Do not add public storage policies. Companies connected before interview rooms were created by HireFlow must reconnect Google once to grant `meetings.space.created`; until then, scheduling shows a reconnect message.
5. Deploy. `vercel.json` schedules `/api/cron/meet` every minute and `/api/cron/gmail` and `/api/cron/recordings` every five minutes; this requires a Vercel plan that supports that frequency and function duration. For other hosting, call each endpoint with `Authorization: Bearer <CRON_SECRET>` from your scheduler.
6. An admin clicks **Connect Google** and chooses the account on Google's consent screen. The connected address is shown afterwards, and the first email import and calendar sync start immediately.

Refresh credentials are encrypted with AES-256-GCM, stored in one server-only row per company and never returned to the browser. Connection changes require current enabled admin membership. Email import and calendar sync each use their own exclusive expiring lease, so one never blocks the other. Reconnecting the same account keeps the email import checkpoint; connecting a different account restarts the import for the new mailbox and makes it the organizer for new interviews immediately. Interviews sent from an earlier account keep their history and saved recordings but are no longer synced or edited from HireFlow; change them in that account's Google Calendar. Disconnect invalidates in-flight work, removes the event subscription and revokes the Google grant unless the same account is still connected to another company. Imported email, sessions and saved recordings remain.

### Email

Candidate matching uses normalized sender email for incoming messages and recipient emails for sent messages, within the connected company only. A unique candidate match is linked automatically; unknown or ambiguous matches appear as unassigned signals for manual linking. No candidates are created from arbitrary email. A first import pages through the mailbox; later runs use Gmail history for incremental updates. **Sync now** triggers an additional pass.

Attachments up to 25 MiB are stored privately and downloaded only after checking current enabled company membership. Email deletions in Gmail are not mirrored into HireFlow. Bodies are displayed as plain text (up to 100,000 characters); remote tracking images and active HTML are not rendered. Spam, trash and drafts are excluded.

Ordinary incoming mail matches the sender. To associate a trusted form-notification email with the applicant listed in its body, configure `GMAIL_APPLICATION_SENDERS` as a comma-separated list of exact notifier addresses. Only those senders can use a standalone `Email: applicant@example.com` line for matching. Leave this unset for general deployments unless that notifier format is intended. This setting applies across the deployment, so use notifier addresses that you control and trust.

### Interviews

HireFlow creates each interview's Meet room itself with host management on and access restricted to the room's members. The selected interviewers are added as co-hosts, so they join directly and can admit people. The candidate is invited through Google Calendar with the link in the event's location and description, but is not a room member: they select **Ask to join** and an interviewer lets them in. The same applies to anyone else with the link. Interviewers need a Google account; if Google cannot make someone a co-host, the session shows why and retries after the address is fixed.

Interviews scheduled before this change keep the Meet link Google Calendar created for them, where invited guests join directly. If Google recording was turned on for them, Google may still record to the organizer's Drive when the organizer joins; HireFlow no longer lists those files, so stop that recording in Meet if you don't want a second copy.

- Calendar titles include the candidate name, for example `Interview — Alex Example`, in HireFlow and Google Calendar. Existing upcoming Google events gain the name on their next sync without another guest invitation.
- Configure `SMTP_*` to send the connected account a separate confirmation after scheduling, edits and cancellations. It contains the candidate name, both dates/times, the scheduling time zone and the Meet link. Guest invitations still come from Google. Email failures appear in session details and retry on the scheduled sync; successful delivery is tracked per interview revision. SMTP delivery is at-least-once: a process failure after SMTP acceptance but before acknowledgement can cause a duplicate; retries keep the same Message-ID. Deployment does not send confirmations for already-synced historical revisions.
- Each session's scheduling and meeting history are synced independently. Google deletes conference records 30 days after a meeting, so HireFlow saves meeting start and end times as soon as it sees them.
- Changes made directly in Google Calendar (time, title, cancellation) flow back into HireFlow. A HireFlow edit sends updated invitations. Google may ask guests to RSVP again after a time change; HireFlow shows Google's latest response.
- A queued change runs only while its author and every selected interviewer are still enabled members. Outcomes that belong to an older revision are discarded.

## Interview recording

Connect a Fireflies API key in Integrations as an enabled company admin. HireFlow verifies the account and encrypts the key using the existing server encryption key; the key never appears in workspace responses. In Fireflies, enable **Capture meeting video** and choose **Only me** for future meetings. Leave calendar auto-record off when HireFlow should control which interviews are recorded.

When Fireflies is connected, recording is automatic for all HireFlow interviews, including interviews created before the connection. There is no per-interview recording setting. Disconnect Fireflies to stop future recorder requests. The scheduled date and time do not restrict recording: opening the interview call early or reopening it later still requests the recorder. Each request allows up to Fireflies’ maximum of two hours. When Google reports a live conference, the server atomically reserves one recorder visit before calling `addToLiveMeeting`. The authenticated Google Workspace Events receiver provides immediate updates; the existing one-minute Meet sync is the fallback. Only interviews belonging to that company, with an enabled scheduling author and interviewers, can dispatch. Admit the recorder in Meet and inform participants about recording. HireFlow invites interviewers to the calendar event, so if the Fireflies account is also an interviewer, set Fireflies auto-join to “Join calendar events only when I invite Fireflies.ai”; otherwise Fireflies sends its own second recorder.

Fireflies limits live joins to three requests per 20 minutes and captures at most 120 minutes per request. HireFlow enforces this limit across connected companies using the same account. Ambiguous timeouts are not automatically resent: check Fireflies before taking another action. Test sends are limited to one per 20 minutes and do not create an applicant recording in HireFlow.

`/api/cron/recordings` polls Fireflies every five minutes for the opaque visit title and exact Meet URL. It imports only matching interview transcripts, without summaries, sentiments, or hiring decisions. Video playback fetches a fresh Fireflies URL after checking enabled company membership. Fireflies hosts these new videos; access depends on its account, subscription, and retention. Saved legacy videos continue streaming from private HireFlow storage. Deleting an interview removes its HireFlow transcript and queues deletion of stored legacy videos; it does not delete the provider's copy in Fireflies.

Run `scripts/verify-fireflies.sql` in the dedicated HireFlow database. Its synthetic fixtures roll back and check admin configuration, secret isolation, automatic recording, tenant isolation, disabled membership, duplicate dispatch and test throttling. Run `npm test`, `npm run typecheck`, and `npm run build`. For the live test, join a synthetic Meet call, use **Send recorder to test meeting**, admit Fireflies, speak synthetic text, end the call, then verify video and transcript in Fireflies. To verify automatic dispatch and in-app playback, schedule a synthetic interview in HireFlow and verify its finished recording appears under the same company.

Primary API references: [live join](https://docs.fireflies.ai/graphql-api/mutation/add-to-live), [transcripts](https://docs.fireflies.ai/graphql-api/query/transcripts), and [video fields](https://docs.fireflies.ai/schema/transcript).

### Instant updates (optional)

Without this, HireFlow checks for meeting starts and ends every minute. With it, Google pushes those events to HireFlow to update meeting history sooner.

1. Enable the Google Workspace Events API and Pub/Sub in the same project (Pub/Sub needs a billing account). Create a topic and grant `meet-api-event-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it.
2. Create a service account for push authentication. Create a push subscription on the topic with endpoint `https://YOUR_APP_HOST/api/meet/events`, authentication enabled with that service account, audience equal to the endpoint URL, and an acknowledgement deadline of 60 seconds.
3. Set `MEET_EVENTS_TOPIC=projects/PROJECT/topics/TOPIC` and `MEET_EVENTS_PUSH_ACCOUNT=<service account email>`, then reconnect Google or wait for the next sync. The Calendar view shows **Instant updates on** once Google confirms the subscription. HireFlow renews it before its seven-day expiry. The one-minute sync keeps running as the recovery path. The push handler rejects untrusted senders and requests redelivery when processing fails or a sync is already busy.

### Verification

Run `npm test` and `npm run typecheck`. `scripts/verify-meet.sql` checks tenant isolation, admin-only connection, membership rules, RSVP preservation, exclusive leases, stale-result rejection, Meet room persistence, recording ownership, cancellation, account switching, email import checkpoints, past-session corrections, disabled members, disconnect invalidation and storage cleanup. It uses synthetic records inside a transaction that is rolled back; run it with `psql` or the Supabase SQL editor. Against a running local app, `APP_URL=http://localhost:3101 node --env-file=.env.local --import tsx scripts/verify-gmail.ts` verifies company isolation, disabled-member access, private resume downloads, matching, manual linking, duplicate imports and disconnect invalidation; it removes its own synthetic records and files. Before claiming the integration is live, connect the real account and check an email import, invitations, RSVP, a time change, a cancellation, and playback of an existing saved video by a second team member. The candidate should have to ask to join.

Calendar preparation requests Fireflies within two minutes before the scheduled start, after syncing the Google Calendar event. Live Meet events still request a recorder whenever the interview starts early or late. The database reserves each request atomically and associates a recent calendar request with the live conference to prevent duplicate bots. A recent calendar request is associated with the human-attended conference. After 13 minutes (allowing for provider startup and the ten-minute lobby wait), HireFlow checks Google participants, Fireflies active meetings, and completed recordings. If the first human arrived at least ten minutes after the request and the bot is absent, one replacement can be requested atomically. Provider read errors, recordings already returned, and requests during an attended interview do not authorize recovery. Empty meetings are marked No recording without repeated bot requests. Anonymous bot detection uses its Fireflies/Notetaker display name; customized names may prevent reliable identification. Provider arrival time and admission remain controlled by Fireflies and Google Meet.
