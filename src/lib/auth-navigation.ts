export function authDestination(origin: string, invitation: string | null) {
  const destination = new URL("/", origin);
  if (invitation && /^[a-f0-9]{64}$/.test(invitation))
    destination.searchParams.set("invite", invitation);
  return destination;
}

export function authCallback(origin: string, invitation: string) {
  const destination = authDestination(origin, invitation);
  destination.pathname = "/auth/callback";
  return destination.toString();
}
