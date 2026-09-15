# HireFlow product scope

An open-source hiring CRM, deployed as a separate Vercel application against the existing Ottawa Painters Supabase project.

## Identity and teams
Email authentication; one account belongs to multiple companies. Company chooser after login and sidebar switcher. Company admins invite users by email, choose admin/member roles, and enable or disable membership without affecting other companies. Invitations expire, are revocable, and are accepted only by the matching verified email. Support both new and existing accounts.

## Hiring
Signals first, alongside configurable stages: Applied, Initial interview (Esma), Manager interview (Zoom), Field trial, Hired, Rejected, Contact later. Move candidates by drag/drop or a stage selector. Candidate details contain contact information, job/experience tags, notes, and Quo calls/SMS. Filter and search candidates. Signals link to candidates by normalized phone or email within the same company; ambiguous matches must remain unresolved.

## Intake and communications
Inspect Jobs List and the existing Meta → Zapier → Sheets flow. Add company-scoped, authenticated, idempotent applicant intake alongside Sheets. Integrate Quo production number +13433265133; no email conversation integration and no AI agents. Future companies configure their own integrations.

## Delivery
Generated UI inspiration in docs/design. Minimal maintainable code, environment example, migration, setup and contribution documentation, open-source license. Verify authentication, cross-company isolation, membership revocation, invitation acceptance, applicant intake retries, communications matching, hiring actions, responsive UI, and deployment. Never include real applicant data or secrets in the repository.
