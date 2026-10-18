- **Adding a cluster to a fleet says what's wrong.** Where it said "The server doesn't answer", it
  names the problem, with what to do: a client certificate or key that isn't one, or a server
  certificate that's for another name (with the names it gives), isn't signed by the CA given, has
  expired or isn't valid yet. "The server doesn't answer" is left for a server that can't be reached
  in time. Removing a cluster that isn't there, a name that isn't text and an empty group get plain
  answers too.
