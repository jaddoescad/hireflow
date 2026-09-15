-- Server-only identity lookup for verified company creation and invitation acceptance.
grant select (id,email,email_confirmed_at) on auth.users to service_role;
