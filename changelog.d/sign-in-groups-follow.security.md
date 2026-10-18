- **Single sign-on: groups follow the provider, and someone it disables is signed out.** Given a
  refresh token (offline_access, for most providers), Lumovi now keeps it, sealed, whether or not
  it passes people's own tokens on, asks the provider again before each ID token expires, and
  revokes it at sign-out where the provider can. Someone's groups are then as the provider says
  now, from their next request. A provider that won't renew a sign-in (the person was disabled or
  removed) ends the session at once; one that renews it without a new ID token doesn't say their
  groups again, so the session ends when the last ID token expires; one that can't be reached is
  asked again, and the session ends when the token it last gave expires. A change to someone's
  groups is in the audit log.
