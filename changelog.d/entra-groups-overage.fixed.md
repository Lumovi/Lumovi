- **Microsoft Entra ID: someone in more than 200 groups signs in with their groups.** Their ID
  token then lists none, only that there are too many to list: Lumovi reads them from Microsoft
  Graph, as them, with User.Read (add it to `LUMOVI_OIDC_SCOPES`), at sign-in and at each renewal.
  Those are the security groups they're in; Microsoft 365 groups don't come through. Where Graph
  can't be read, they sign in with no groups, and the Account menu says so. A national cloud's
  Graph is set with `LUMOVI_OIDC_GRAPH_URL`.
