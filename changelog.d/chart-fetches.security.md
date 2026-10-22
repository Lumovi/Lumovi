- **A server connects only to the address it checked when it fetches a chart.** Where it fetches
  charts from public addresses alone (unless LUMOVI_ALLOW_PRIVATE_CHARTS allows private ones),
  Lumovi now resolves each name once, checks every address it gives, and connects to those alone,
  for a repository's index and charts, a registry's, a chart at a URL and a chart's icon, and each
  redirect's. It fetches every chart itself, from a repository, a registry or a URL, and hands Helm
  the file. A chart from a repository whose index lists no digest is refused there, since Lumovi
  can't check what it fetched. Through a proxy, the proxy resolves the name.
