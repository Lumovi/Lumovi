- **Lists and opened objects update as the cluster changes**: a pod starting, failing or going
  away shows in about a second, rather than at the next read every 5 seconds. Lumovi watches what
  a page shows while it's shown, so a list that isn't changing isn't read again and again (once a
  minute still, to be sure). Where a cluster refuses to be watched, and for Secrets on a server and
  a fleet's clusters reached through their agent, lists are read every few seconds as before.
