- **Helm: repositories, a chart browser, and Update available.** The Helm page has tabs:
  Releases, Charts and Repositories. Repositories are added there (HTTP, or an OCI registry with
  the charts to look for), tested, edited and removed; Lumovi keeps them itself, not in Helm's own
  list, and reads them every 30 minutes and when the page opens. A sign-in is sent only over
  https, only to its repository, and is kept in the system's keychain on the desktop (none is kept
  without one) or sealed on a server, where only Lumovi's admins add repositories. Helm never sees
  it: Lumovi fetches the chart, checks it against the digest its repository lists, and hands Helm
  the file. Charts lists what's in them, with each chart's versions and Install. A release Lumovi
  installed from a repository, or whose chart matches the one repository that has it, says
  "Update available" when there's a newer version there, and Upgrade opens with it.
