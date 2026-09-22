# Google Meet integration: capabilities and implementation decisions

Research date: September 22, 2026. This is an architecture proposal based on current official Google documentation and a review of the unfinished HireFlow implementation. It is not a claim of successful live integration. Examples are synthetic.

## Recommendation

Build an interview-session feature with Google Calendar for scheduling and invitations, Meet for conferencing and recording configuration, Workspace Events for meeting updates, and Drive for video access. Keep HireFlow's dedicated Supabase database authoritative for company membership, candidate associations, and durable session history.

Treat these as separate concerns from the outset:

1. Scheduling and RSVP.
2. Who owns and who can host the meeting.
3. Whether recording is configured, actually running, processing, or available.
4. Who can watch the recording.
5. Recovery when a Google request or notification is delayed, duplicated, or missed.

The two decisions that most affect the implementation are the meeting-creation path and the playback access model. Both require a small real-account acceptance test before the architecture is considered validated.

## Capability map

| Capability | Feasibility | HireFlow treatment |
| --- | --- | --- |
| Schedule, reschedule, cancel, and invite candidates and teammates | Supported through Calendar | Core |
| Track accepted, declined, tentative, and unanswered invitations | Supported through Calendar | Core; separate from actual attendance |
| Month, week, and agenda views | HireFlow UI over saved sessions | Core calendar; views can share one model |
| Open Meet from a session | Supported through meeting URI | Core; open Google Meet |
| Automatically configure recording | Supported, subject to organizer entitlement and meeting conditions | Core with explicit readiness state |
| Assign co-hosts programmatically | Generally available, with scope and space-ownership constraints | Core when interviewers host under their own Google accounts |
| Detect meeting start/end and recording readiness | Supported through Workspace Events and Meet queries | Core |
| Attach multiple recording segments | Supported | Core; never assume one file per interview |
| Watch in Google Drive | Supported using artifact playback URL and existing Drive permissions | Simplest playback option |
| Watch inside HireFlow with HireFlow-controlled access | Possible using authorized Drive media retrieval or a private copied asset | Additional permission and delivery work |
| Check interviewer availability | Calendar FreeBusy, subject to calendar visibility | Useful addition |
| Record attendance and join/leave times | Meet participant/session resources | Optional factual history, no automated hiring assessment |
| Retrieve transcripts | Supported when generated and permitted | Optional; separate from recordings |
| Embed HireFlow tools inside Meet | Meet add-on SDK | Possible later; separate product surface |
| Embed the full Google Meet call inside HireFlow | No general embeddable call client supplied by the REST/add-on APIs | Use the Meet join URL |
| Guaranteed unattended recording of every call | Not guaranteed | Never promise |
| Generate a recording after an unrecorded call | Not supported by artifact retrieval | Show no recording |
| Start/stop recording using a dedicated REST command | No such method in the documented v2 surface reviewed | Configure automatic recording; use Meet controls for manual operation |

Google documents the management and artifact capabilities in its [Meet overview](https://developers.google.com/workspace/meet/api/guides/overview) and the available operations in its [v2 API reference](https://developers.google.com/workspace/meet/api/reference/rest/v2). Calendar owns scheduled-event functionality; see [event creation](https://developers.google.com/workspace/calendar/api/guides/create-events).

## Organizer, interviewer, and co-host are different roles

Use the company's connected interview account as the stable organizer. An administrator configuring Workspace is not automatically the organizer used by HireFlow. Authenticate the actual organizer through OAuth and verify its Google identity.

A Calendar attendee is not automatically a Meet co-host. An internal HireFlow member is not automatically a Google Workspace user, either. Store the selected interviewer and their Google identity explicitly when assigning hosting privileges.

Google made the v2 meeting-members API generally available on September 11, 2026. The new API supports adding, changing, and removing members and assigning the COHOST role. This materially expands what we can automate compared with older guides. [Meet release notes](https://developers.google.com/workspace/meet/release-notes)

Business Standard supports co-hosts. Host management and recording-artifact sharing are distinct settings; Google's help describes a separate artifact-sharing choice and limitations for co-hosts added during a call. We must not infer playback rights from a successful co-host assignment. [Co-host requirements and artifact sharing](https://support.google.com/meet/answer/10885841?hl=en)

### Creation-path decision

**Calendar-first:** Create a Calendar event with conferenceData.createRequest and conferenceDataVersion=1. Wait for conference creation to complete, then configure recording using the Meet settings scope. This provides native Calendar conferencing and a retryable Calendar event ID. It is a good fit when the connected organizer personally hosts.

**Meet-first:** Create the space through Meet as the organizer, persist its canonical name and URI, configure host management and recording, assign internal co-hosts, and create the Calendar invitation with that meeting URI. This is the preferred candidate architecture when different employees conduct interviews while one account remains organizer.

Why this matters: the members.create reference requires meetings.space.created. The authorization guide describes that scope as covering spaces created by the app. The current Calendar-first code requests only readonly and settings Meet scopes. Adding a scope alone must not be assumed to make Calendar-generated spaces app-created. [Members.create](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces.members/create), [Meet authorization](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)

**Unresolved integration detail:** the Calendar schema supports conference entry points, but the documentation reviewed does not establish every aspect of attaching a REST-created Meet space as a fully native Google Calendar conference with equivalent invitation and artifact-sharing behavior. A location/description join link is straightforward; native conference attachment and co-host interoperability must be verified together. Do not manufacture a conference signature or create a second Meet room accidentally. [Calendar event schema](https://developers.google.com/workspace/calendar/api/v3/reference/events)

Meet spaces.create also does not document a client request ID in the method reference. Do not transfer Calendar's idempotency assumptions to it. Persist the returned space immediately; explicitly handle an ambiguous creation timeout without distributing multiple room links. [Spaces.create](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create)

## Recording behavior and honest product states

Business Standard is recording-eligible, subject to administrator settings. Automatic features wait until a host or co-host joins on the web. Recording also depends on storage availability; participants see recording notifications. Therefore a configured recording is not evidence that a video exists. [Recording requirements](https://support.google.com/meet/answer/9308681?hl=en)

The organizer can configure recording separately from transcription and Gemini notes. Keep Gemini notes disabled for HireFlow meetings under the repository's no-agent/no-automated-hiring requirement. Do not change organization-wide settings. Configuration of automatic artifacts also applies to Calendar-created spaces using meetings.space.settings. [Meeting configuration](https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration)

Use independent state fields:

| Concern | Suggested states |
| --- | --- |
| Scheduling | draft, provisioning, scheduled, cancellation_pending, cancelled, needs_attention |
| Conference | not_started, active, ended, unknown |
| Recording setup | requested, enabled, disabled, unsupported, failed |
| Each recording | recording, processing, available, unavailable |
| Integration health | connected, reconnect_required, permission_denied, delayed |

The recording API reports STARTED, ENDED, and FILE_GENERATED. Preserve each recording's unique resource name, conference name, timestamps, Drive file ID, and export URI. A stop/restart may produce multiple recording resources. [Recording resource](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.recordings)

Use one unique space per interview. One space can have several actual conferences over time, so model session → space → conferences → recordings. Treat an unexpected later reuse as something to inspect rather than silently mixing unrelated calls.

Conference records expire 30 days after the conference ends. Save the identifiers and metadata before that window closes. This is not a 30-day video-deletion rule. [Conference record retention](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords)

Videos live in the organizer's Drive and follow its retention rules. Meet can still return recording metadata after someone deletes the Drive file. Preserve the history and show an unavailable recording rather than claiming playback is guaranteed. Prefer Google's exportUri for browser playback. [Artifact storage and retrieval](https://developers.google.com/workspace/meet/api/guides/artifacts)

## Playback: choose the access model deliberately

| Option | Benefits | Limitations |
| --- | --- | --- |
| Open in Drive | Minimal infrastructure; Google handles playback | Viewer must have Google file access; disabling a HireFlow account does not revoke existing Drive access |
| Stream through HireFlow | HireFlow can check company membership on each media request; no permanent second copy | Needs authorized Drive media access, range requests, bandwidth, and runtime validation |
| Copy to private HireFlow storage | Stable in-app playback independent of later source-file deletion | Extra storage, transfer jobs, retention/deletion policy, and secure delivery |

For in-app playback, use a server route that resolves a recording by company and session, checks live membership, and fetches only that stored file ID. Never accept an arbitrary Drive file ID or expose organizer tokens. Implement byte ranges and seeking; do not buffer an entire video in a serverless function. Google documents partial blob downloads using Range. [Drive download guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads)

The narrow drive.meet.readonly scope is accepted by files.get and covers Meet-created/edited files. It remains a restricted scope. A generic drive.file grant is not blanket access to every future Meet recording. [Files.get authorization](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get), [Drive scope definitions](https://developers.google.com/workspace/drive/api/guides/api-specific-auth?hl=en)

For an external multi-company service, restricted-scope use may require verification and a security assessment, depending on deployment and applicable exceptions. An organization-owned internal app has a different verification path, but only supports its permitted organization audience. Open-source code does not itself make an OAuth application internal. [Restricted-scope verification and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

Recommendation: if all enabled HireFlow teammates must watch without individual Google file sharing, choose in-app delivery explicitly. Start with private, authenticated streaming and validate realistic video size/runtime behavior; introduce private copied assets only if reliability or retention requirements justify them. A Drive preview iframe still relies on Google authorization and is not equivalent.

## Scheduling, invitations, and availability

Calendar creates the event and sends invitations and update/cancellation notices. Use sendUpdates=all for attendee-facing changes. Persist a stable event ID to recover from response loss; distinguish provider acceptance from email delivery and RSVP. Do not set an attendee to accepted on their behalf. [Events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

Some recipients' invitation settings prevent an unfamiliar organizer's invitation from appearing automatically until they respond. HireFlow can report the invitation and response state, but cannot force their personal calendar settings. [Inviting attendees](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events)

FreeBusy supports conflict checks across calendars the authorizing user can access. Add calendar.events.freebusy if this is included; calendar.events.owned alone is not sufficient for this endpoint. Missing visibility means unknown availability, not free. Candidate self-booking would be a separate HireFlow feature built on availability and scheduling rules. [FreeBusy reference](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)

Store UTC instants plus the intended IANA time zone. Show the selected zone while editing. Test daylight-saving gaps and repeated times. Recheck availability at submission and disclose that Google Calendar does not provide a global transaction that locks every attendee's calendar.

RSVP and attendance must remain separate. Actual joins/leaves come from Meet participant sessions; anonymous and phone users may not provide a reliable email identity. Attendance is factual context, not an automated no-show or hiring decision. [Participant resources](https://developers.google.com/workspace/meet/api/guides/participants)

## Synchronization and failure recovery

Use two notification paths and one recovery worker:

1. Calendar watch notifications trigger incremental event synchronization.
2. Workspace Events sends conference and recording notifications through Pub/Sub.
3. A scheduled worker renews subscriptions, retries operations, and reconciles missed updates.

Calendar notifications contain change signals rather than full event bodies. Channels expire and must be replaced; overlap can occur. Verify the saved channel token/resource identity before scheduling work. [Calendar push notifications](https://developers.google.com/workspace/calendar/api/guides/push)

Keep Calendar nextSyncToken values and consume every page before advancing the checkpoint. A 410 invalidates the provider synchronization checkpoint. Rebuild the Google-event mirror without deleting HireFlow's candidate links, interview history, or saved recording mappings. [Incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)

Protect updates with Calendar etags and If-Match. On conflict, reconcile or ask the user to reload; never silently overwrite a newer edit made directly in Google Calendar. [Versioned updates](https://developers.google.com/workspace/calendar/api/guides/version-resources)

Meet subscriptions can target a space or all spaces owned by a user. Organizer-level subscriptions are operationally simpler, but events for unrelated meetings must be discarded unless their space maps to a HireFlow session. Subscribe to conference start/end and recording start/end/fileGenerated. [Meet event subscriptions](https://developers.google.com/workspace/events/guides/events-meet)

Subscriptions omitting resource data can last up to seven days; those including it have shorter limits. Store the actual expiration returned and renew early. Do not confuse a Workspace subscription with the separate Pub/Sub subscription. [Subscription lifetime](https://developers.google.com/workspace/events/reference/rest/v1/subscriptions)

Configure the Google Meet publisher on the Pub/Sub topic and use authenticated push to HireFlow. Validate signature, issuer, audience, expiry, and expected service-account identity before accepting events. Durably insert the event or job before acknowledging delivery. [Subscription setup](https://developers.google.com/workspace/events/guides/create-subscription), [Authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

Design handlers for duplicate and out-of-order deliveries: unique event keys, unique recording resource names, state re-fetch, per-session serialization, bounded retries with jitter, and visible failure status. Process pending mutations and recent conferences before settled historical sessions. Continue recording reconciliation after Calendar cancellation when a conference already took place.

## Data and authorization model

Proposed logical records, all company-scoped:

| Record | Important fields |
| --- | --- |
| Google connection | Google subject, organizer email, encrypted token, granted scopes, generation, health |
| Interview | candidate, title, schedule, zone, organizer connection, local version, Google event ID/etag, canonical space name |
| Interview attendee | internal user or candidate, invitation email, RSVP, desired/observed host role |
| Conference | canonical conference name, interview, actual start/end, provider expiry |
| Recording | canonical recording name, conference, state, Drive ID, export URI, optional private asset |
| Sync state and jobs | Calendar token, watch channel, Workspace subscription, expirations, deduplication keys, attempt/checkpoint |

This need not be a separate service or elaborate event framework: small Postgres tables, transactional claims, and Next.js handlers are sufficient.

Enforce enabled company membership in reads and atomic mutations. Use composite foreign keys to prevent cross-company associations. Resolve tenant identity from saved connection/resource mappings, never a webhook's asserted company ID. Keep tokens and worker operations server-only.

The database and Google cannot share a transaction. Recheck authority before external effects, reject stale generation/version results, serialize writes, and reconcile revocations. A disabled HireFlow account must immediately lose HireFlow access; revoking an existing Google invitation, role, or Drive grant is a separate provider operation.

## OAuth and operational setup

| Scope | Purpose |
| --- | --- |
| openid, email | Verify organizer identity |
| calendar.events.owned | Manage events on organizer-owned calendars |
| meetings.space.created | Create app-owned spaces and manage their members |
| meetings.space.settings | Configure meeting settings/automatic artifacts |
| meetings.space.readonly | Read other accessible spaces and artifacts when supporting Calendar-created/existing meetings |
| calendar.events.freebusy | Optional availability checks |
| drive.meet.readonly | Optional authorized in-app video retrieval |

Request only the scopes needed for the selected creation/playback paths; do not require every optional scope for link-only operation. Ordinary organizer OAuth is the default. Domain-wide delegation is possible, but broader than required for a single connected organizer.

Keep long-lived refresh tokens encrypted and handle revoked authorization explicitly. External apps in OAuth Testing normally receive seven-day refresh tokens for these scopes; this is unsuitable for unattended production synchronization. [OAuth token lifecycle](https://developers.google.com/identity/protocols/oauth2)

Enable Calendar, Meet, Workspace Events, and Pub/Sub in the selected HireFlow Cloud project; enable Drive for in-app media. Verify OAuth redirect URLs, granted scopes, real organizer license, storage availability, and subscriptions.

Standard Meet API usage has no additional API charge. Published per-user/project minute limits include 600 reads, 100 writes, and 10 space-creation requests; actual project quotas can differ. Google also documents planned billing changes for usage above standard quotas. Budget separately for Pub/Sub, application bandwidth, and optional copied videos; do not promise permanently unlimited free usage. [Meet quotas and pricing](https://developers.google.com/workspace/meet/api/guides/limits), [Workspace quota changes](https://developers.google.com/workspace/tools-safety)

## Changes required in the unfinished implementation

Implemented on September 22, 2026. The co-host, in-app playback and Calendar watch-channel items were deferred because the organizer hosts every interview and invited teammates get Drive access. See `docs/INTEGRATIONS.md`.

The current local code is a useful prototype, not the finished integration. No live meeting/recording acceptance test has been completed.

| Gap observed | Required change |
| --- | --- |
| Calendar-generated space with no co-host provisioning | Resolve creation strategy and validate real co-host behavior |
| Five-minute polling only | Add event ingestion, subscription renewal, and recovery reconciliation |
| One combined recording setup/sync status | Separate configuration, actual recording, processing, and file availability |
| Cancelled sessions excluded from synchronization | Continue artifact collection for past/active conferences |
| Old sessions continually revisited in batches | Prioritize pending writes and recent conferences; retire settled polling |
| No canonical conference record persisted | Save the full session/space/conference/recording relationship |
| External title edits not synchronized; edits lack etag protection | Define field ownership and reconcile Calendar changes safely |
| 404 treated as cancellation in some paths | Distinguish access failure, deletion, and transient ambiguity |
| Recording retrieval inside the same try block as configuration | Keep already-generated recording discovery working if configuration fails |
| Playback is a constructed Drive link only | Save exportUri and implement the selected access model |
| Browser-local date editing only | Make time zone and ambiguous local times explicit |
| Per-company connection accepts new organizer after cancellations | Preserve old organizer connections needed to reconcile historical artifacts |
| No full integration test suite yet | Add isolation, retries, notifications, hosting, and real playback acceptance tests |

## Acceptance gates before release

1. **Hosting:** prove the selected creation path, correct organizer, native/link Calendar behavior, internal co-host joins without organizer, and removal of a co-host.
2. **Invitations:** use controlled test recipients to verify initial invite, RSVP, time change, attendee replacement, cancellation, and no duplicate event after a timeout/retry.
3. **Recording:** run a short synthetic call; verify automatic start under the intended host arrangement, multiple recording segments, processing, ready notification, and actual playback.
4. **Access:** test another company, disabled member, removed interviewer, wrong Google account, expired connection, and unauthorized video request.
5. **Recovery:** duplicate/reordered events, handler crash, expired subscription, missed webhook, invalid Calendar sync token, and provider throttling.
6. **History:** saved recording remains mapped after conference metadata expires; deleted/inaccessible source video has an honest unavailable state; cancellation does not discard artifacts.
7. **UI:** desktop/mobile calendar, candidate sessions, daylight-saving transitions, retries, join link, recordings, and manual refresh.

Do not mark the integration complete until those behaviors have been exercised. The immediate next engineering step is the hosting-and-playback proof, followed by finishing the implementation against the verified architecture.

## Verification pass (September 22, 2026)

Second review against the official reference pages. The claims above held; these are the corrections and additions that change decisions.

- **Co-host writes only work on app-created spaces.** `spaces.members` (GA 2026-09-11) has `create`, `get`, `list`, `patch`, `delete` and `batchUpdate` (up to 500 per batch). Writes accept only `meetings.space.created`, and member methods reject the `{meetingCode}` alias. Co-hosts cannot configure auto-artifacts or moderation. [Members](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces.members)
- **Auto-recording on Calendar-created spaces is officially supported** with the non-sensitive `meetings.space.settings` scope, but only when the call is made as the organizer. All SpaceConfig fields (access type, moderation, attendance report, auto recording/transcription/smart notes) are GA. [Release notes](https://developers.google.com/workspace/meet/release-notes)
- **Smart notes** now have a GA `conferenceRecords.smartNotes` resource and Workspace Events. HireFlow keeps them off.
- **Workspace Events payloads carry only resource names;** HireFlow re-fetches details from Meet. Non-owner targets receive only `conference.started` and `transcript.fileGenerated`, so subscribe as the organizer (`//cloudidentity.googleapis.com/users/{id}`) or per space. Renew with `subscriptions.patch` (`updateMask=ttl`, `ttl: "0s"`); `reactivate` is only for SUSPENDED subscriptions. [Meet events](https://developers.google.com/workspace/events/guides/events-meet)
- **Calendar attachment of a Meet-API space is not officially documented.** Only copying `conferenceData` from another Calendar event is shown. Calendar-first remains the documented path.
- **OAuth audience:** apps whose consent screen is set to *Internal* to one Workspace organization need no Google review for sensitive or restricted scopes, including `drive.meet.readonly`. External apps using restricted scopes need verification plus an annual security assessment. [Consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)
- **Recording storage:** since July 2026 recordings land in the organizer's "Google Meet" Drive folder (the old folder becomes "Legacy Meet Recordings"). Never locate files by folder name; use `driveDestination.file`. In-organization participants and co-hosts named on the event get access automatically; external candidates do not. [Recording help](https://support.google.com/meet/answer/9308681)
- **Quotas:** per project/minute 6000 reads, 1000 writes, 100 `spaces.create`; per user per project/minute 600 / 100 / 10. Overage charges are planned for later in 2026 without published prices. [Limits](https://developers.google.com/workspace/meet/api/guides/limits)
- **Meet Media API** is still developer preview and requires every participant to be enrolled. Not usable for HireFlow.

Still unconfirmed: the Calendar scope classification (likely sensitive), the maximum Calendar watch-channel lifetime, and whether member writes can ever apply to Calendar-created spaces.
