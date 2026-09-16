# Launch verification

Verified September 15–16, 2026.

- **Production:** https://hireflow-theta-seven.vercel.app
- **Deployment:** `dpl_2t6KebRPTeartFQ4tzhWEVYQnFQL`, ready and aliased to production.
- **Database and authentication:** dedicated HireFlow Supabase project `slpzezujtpjrxlugalqs`, Canada Central; foundation and Gmail migrations applied.
- **Admin:** `info@paintersottawa.com`; both email-link and one-time-code login verified through the real Gmail inbox. The restored account has no migrated password and can use email sign-in.
- **Sender:** `hireflow@homeproapps.com`, MXroute port 587, configured separately for Supabase Auth and application invitations. MX, SPF and DKIM verified. Fixed the MXroute local-delivery setting for paintersottawa.com to match its Google-hosted mailbox. Auth email limit: 30/hour. Leaked-password protection enabled; the security advisor reports no warnings. The two no-policy notices are expected for server-only integration and invitation tables.

## Product verification

| Requirement | Evidence |
| --- | --- |
| Multiple companies and team access | Database tests cover shared accounts, membership isolation, immediate disable and concurrent last-admin protection. A fresh browser accepted a second-company invitation and switched between member and admin workspaces. |
| Invitations | Production HTTP tests verify identity, acceptance and revocation; database tests verify retries, expiry and new/existing accounts. SMTP delivery to the controlled HomeProApps mailbox succeeded. Browser acceptance persisted as the expected member role. |
| Hiring workflow | Browser-created candidate, stage movement and notes were independently checked in the database. Search, role/experience/tag filters, configurable stages and drag/drop are implemented; stage selection also supports touch and keyboard use. |
| Responsive UI | Inspected the production board, company switcher, candidate form and candidate detail at 390 × 844. Added a candidate, moved it to Initial interview and saved a note. No browser errors appeared. |
| Isolation and secrets | Database tests cover RLS, forbidden client writes, server-only secrets and cross-company references. HTTP tests cover sessions, origins, company authorization and secret redaction. |
| Intake and retries | Production HTTP checks pass. The actual Zapier POST test created the expected record and a repeat returned the same ID with `duplicate=true`. |
| Communications | Quo's signed dashboard test reached the endpoint with HTTP 200; its different-line payload was correctly ignored. Signed HTTP tests verify candidate matching, retries, wrong-line exclusion and ambiguous contacts. Real history fetched from Quo is matched to imported applicants and rendered in Activity. These checks use provider tests and historical messages; no claim is made that a new candidate call was placed during verification. |
| Build and repository | Unit tests, TypeScript and production build pass. GitHub Actions is configured for these checks without secrets. Current private credentials and all 549 imported applicant email addresses were scanned against tracked files and Git history with no matches. Private backups and test artifacts are ignored and excluded from deployment. |

All synthetic verification companies, users and candidates were removed. Final production check: 549 applicants, seven stages, three SMS activities and the enabled admin membership.

## Connected workflows

The active Hiring Zap is `368944213`, v7, **Interior + Exterior Hiring | Facebook Leads → Hiring Sheet**. The HireFlow POST step `380248193` follows Sheets and precedes Delay. Existing Sheets, email, delay and Quo steps remain intact. Mapping includes lead ID, contact information, role, experience, category, leadership, transportation, availability, pay and application time.

All 549 current Hiring Sheet applicants were imported. Thirteen invalid phone values are retained in attributes and tagged **Phone needs review**; no phone numbers were guessed. Other sheet answers are preserved. Cards label their creation timestamp **Added** to distinguish it from a historical application date.

Quo uses the dedicated **hireflow-production** key and Production line `PNHtOrvjNR` (+13433265133). Webhook `WH31992cc0f3b94ba3a94d9658c202ae26` subscribes to `call.completed`, `message.received` and `message.delivered` for that line. Each company can configure its own integration in Settings.

## Infrastructure cleanup

The HireFlow Cloudflare Worker and D1 database were deleted; its email sending was disabled and its generated DNS records removed. A final DNS search for HireFlow returned no records. Workers Paid renewal is canceled, ending October 11, 2026. Unrelated applications, domain records and subscriptions were preserved.

The repository includes an MIT license, setup/contribution instructions, environment example, migrations, integration guide, reusable sign-in email template and generated design reference. It is prepared for the owner's GitHub publication; no public repository has been created by this task.

## September 16 interaction update

Kanban moves now update cards and counts immediately, serialize rapid writes per candidate, and preserve pending destinations through background refreshes. Save feedback, Undo, rollback with Retry, focused drop targets and edge scrolling are implemented. Local browser checks held save requests open and verified refresh, failure, retry and undo; production drag testing independently confirmed immediate placement before the request was released and persisted stage afterward. All synthetic test records were removed. Eight unit tests, TypeScript and production build pass.

The combined deployment also includes the compact Chat-first candidate view from the parallel task. That task verified desktop/mobile presentation, server-side chat filtering before pagination and company authorization against production.


## Gmail integration — connected, final resume verification pending

Deployment `dpl_2t6KebRPTeartFQ4tzhWEVYQnFQL` is **READY** and serves the production alias. Unique URL: https://hireflow-8amznkvx3-jad-slims-projects.vercel.app. It includes the Gmail implementation and production Google OAuth credentials.

- Email chat bubbles, incoming/sent matching, private resume downloads, unmatched-email linking and admin Gmail controls are implemented.
- Fourteen unit tests, TypeScript and production build pass. Production HTTP/database checks pass for tenant isolation, disabled members, admin-only setup, private attachment downloads, matching, linking, deduplication, lease exclusion and disconnect invalidation. All synthetic fixtures were removed. The synthetic email conversation was visually inspected in the browser.
- The database security advisor has no warnings/errors; its three informational notices are intentional server-only tables without client RLS policies.
- Vercel Pro was verified. The five-minute production cron is registered; unauthenticated invocation returns 401 and authenticated invocation returns 200. Encryption and scheduler secrets are stored only in ignored local configuration and sensitive Vercel production variables.
- **Connected:** `hiring@paintersottawa.com` authorized the read-only Gmail connection. The first real import completed at 13:41:19 UTC on September 16 and imported one account-notice email. It correctly remains unmatched and has no attachment.
- **Scheduled sync verified:** Vercel invoked `/api/cron/gmail` at 13:45:22 UTC with HTTP 200; the database records successful completion at 13:45:25 UTC, no error, a saved history cursor and a released lease. No manual sync was invoked for this check.
- Dedicated Google Cloud project **HireFlow Gmail** (`integral-kit-508813-i7`) was created under the paintersottawa.com organization without selecting a billing account. Gmail API is enabled, and the Web OAuth client's callback is the production `/api/gmail/callback` URL. Client credentials remain in ignored local configuration and sensitive production variables.
- The Google app uses **Internal** audience for the paintersottawa.com Workspace organization. This deployment's Gmail authorization does not yet support unrelated companies' Google accounts; public distribution requires an appropriate External audience and Google's applicable verification. General HireFlow company membership is independent of this Gmail audience restriction.
- Remaining verification: deliver a clearly labeled synthetic resume email to the connected mailbox, confirm automatic candidate matching and download the actual imported PDF. The test email and synthetic PDF are prepared in ignored `tmp/pdfs/`; sending awaits explicit user authorization. Existing synthetic HTTP/database tests prove access controls and matching logic but do not replace this real Gmail attachment check.
